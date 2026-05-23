/**
 * Node-side AutoDock Vina runner for MOLECULAR_DOCKING work orders.
 *
 * Pipeline (per WO):
 *   1. Receptor cache:   download <pdbId>.pdb from RCSB if not on disk
 *   2. Receptor prep:    convert <pdbId>.pdb → <pdbId>.pdbqt via Open Babel
 *   3. Ligand prep:      convert SMILES → ligand.pdbqt via Open Babel
 *   4. Vina invocation:  spawn `vina` with the binding-site box + WO seed
 *   5. Output parsing:   parseVinaPdbqt(out.pdbqt) → DockingPose[]
 *   6. Submission build: hash output, attach pose array, return payload
 *
 * External binaries required: `vina` (v1.2.5) and `obabel`. Both must be
 * on PATH. Their absence is detected by `assertBinariesAvailable()` —
 * docking WOs are rejected loudly if either is missing rather than
 * silently fall back to a fake result.
 *
 * No sandboxing today — same trust model as `trainer.ts` (subprocess
 * inherits parent env, no cgroups). The trust assumption is the same as
 * for training: we run our own Vina binary against payloads we issued.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import * as https from 'https';
import logger from '../../utils/logger';
import { parseVinaPdbqt } from './vina-parser';
import type {
  DockingPose,
  DockingSubmissionPayload,
  DockingWorkOrderPayload,
} from './types';

const RECEPTOR_CACHE_DIR = path.join(os.homedir(), '.synapseia', 'docking', 'receptors');
const DEFAULT_VINA_TIMEOUT_MS = parseInt(process.env.VINA_TIMEOUT_MS || '1200000', 10); // 20 min
const VINA_HOME_BIN = path.join(os.homedir(), '.synapseia', 'bin', 'vina');
const DEFAULT_VINA_BIN = process.env.VINA_BIN
  || (existsSync(VINA_HOME_BIN) ? VINA_HOME_BIN : 'vina');
const DEFAULT_OBABEL_BIN = process.env.OBABEL_BIN || 'obabel';

/**
 * Default total wall budget for Open Babel `--gen3d` ligand prep and
 * receptor protonation. Bumped 180s → 600s after Bug 20 (2026-05-17).
 *
 * Bug 20 v4 (2026-05-23) — the 600s budget itself was sound, but the
 * SHAPE of how it was spent was the #2 root cause: a flat 50/50 split ran
 * `--gen3d med` (the slow, brute-force tier) FIRST for the full 300s, so
 * every doomed ligand burned ~600s before failing. v4 inverts the order
 * (fast tier first, see `prepLigandPdbqt`) and shortens the fast tier to a
 * tight per-tier budget so pathological ligands fail in ~90s instead of
 * ~600s. The total budget below is unchanged; only the split changed.
 *
 * Override via `DOCKING_OBABEL_TIMEOUT_MS` when running on slower hardware
 * or with even more complex ligands. parseInt tolerates trailing garbage;
 * NaN/0 falls back to the default.
 */
function parseObabelTimeoutEnv(): number {
  const raw = process.env.DOCKING_OBABEL_TIMEOUT_MS;
  if (!raw) return 600_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}
const DEFAULT_OBABEL_TIMEOUT_MS = parseObabelTimeoutEnv();

/**
 * Bug 20 v4 (2026-05-23) — fast-tier per-attempt budget. The fast tier
 * runs FIRST now; we cap it tight so pathological ligands fall through to
 * RDKit (or fail) quickly instead of consuming half the total budget.
 * Default 90s; clamped to never exceed half the total obabel budget.
 * Override via `DOCKING_FAST_TIER_MS`.
 */
function parseFastTierEnv(): number {
  const raw = process.env.DOCKING_FAST_TIER_MS;
  if (!raw) return 90_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
}
const DEFAULT_FAST_TIER_MS = parseFastTierEnv();

interface RunChildOpts {
  timeoutMs: number;
  /** Diagnostic context surfaced when the timeout fires. */
  timeoutContext?: { step?: string; input?: string };
  /**
   * Bug 20 v4 (2026-05-23) — when true, the child is launched at reduced
   * CPU priority (`nice -n 19`) so it yields to concurrent torch GPU
   * training. This is the highest-impact lever against the #1 root cause
   * (CPU contention starves obabel's single-threaded gen3d search). Only
   * obabel/RDKit prep spawns set this; Vina itself keeps normal priority
   * (it is the work we are paid for). Gracefully degrades to a normal
   * spawn when `nice` is unavailable (detected once, cached).
   */
  nice?: boolean;
}

/**
 * Bug 20 v4 (2026-05-23) — grace window between SIGTERM and SIGKILL when a
 * child overruns its timeout. obabel occasionally ignores SIGTERM mid
 * conformer search (or spawns helper subprocesses), leaving a zombie that
 * keeps burning CPU after the "timeout" already rejected — exactly the
 * contention we are trying to relieve. After SIGTERM we wait this long,
 * then SIGKILL the whole process group. Override via env for slow hosts.
 */
function parseKillGraceEnv(): number {
  const raw = process.env.DOCKING_KILL_GRACE_MS;
  if (!raw) return 4_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4_000;
}

/**
 * Bug 20 v4 (2026-05-23) — cheap, parse-free SMILES complexity proxy.
 * The #3 root cause is the occasional pathological ligand whose gen3d
 * conformer search never converges. Counting heavy atoms (any character
 * that is NOT a bond/branch/ring/charge/stereo token — i.e. an element
 * letter or a bracketed atom) and rotatable-bond proxies (acyclic single
 * `-`/implicit bonds, approximated by counting non-ring single-bond
 * boundaries) lets us short-circuit obabel's brute-force search BEFORE
 * burning the budget, jumping straight to RDKit ETKDGv3 which embeds
 * large flexible molecules in seconds.
 *
 * Thresholds are intentionally conservative — we only want to skip
 * obabel for genuinely large/flexible ligands, not borderline drug-like
 * ones (Indinavir ~57 heavy atoms still embeds fine on a quiet CPU). The
 * defaults below were picked so all of the named pod offenders
 * (Indinavir, Imatinib, Saquinavir) sit UNDER the gate and only truly
 * pathological inputs trip it. Override via env for tuning.
 */
function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Heavy-atom count above which we skip obabel gen3d (default 80). */
const LIGAND_HEAVY_ATOM_GATE = parseIntEnv('DOCKING_MAX_HEAVY_ATOMS', 80);
/**
 * Rotatable-bond proxy above which we skip obabel gen3d (default 40).
 *
 * Calibrated conservatively: the named pod offenders all sit under it
 * (Indinavir's acyclic-single-bond proxy ≈ 29). We only want to skip
 * obabel for ligands materially MORE flexible than Indinavir, where the
 * brute-force conformer search blows up combinatorially. The proxy
 * over-counts slightly vs. RDKit's true rotatable-bond definition (it
 * does not exclude terminal/symmetric bonds), so the gate is set above
 * the worst legitimate offender with margin.
 */
const LIGAND_ROTATABLE_GATE = parseIntEnv('DOCKING_MAX_ROTATABLE_BONDS', 40);

export interface SmilesComplexity {
  heavyAtoms: number;
  rotatableProxy: number;
}

/**
 * Estimate ligand complexity directly from the SMILES string — no RDKit /
 * obabel parse. Exported for unit testing the gate thresholds.
 *
 * - heavyAtoms: organic-subset atoms outside brackets (B,C,N,O,P,S,F,Cl,
 *   Br,I — two-letter halogens counted once) PLUS each bracketed atom
 *   `[...]`. Lowercase aromatic atoms (c,n,o,s,p) count too. Hydrogens are
 *   ignored (they are the `H` we add at gen3d time, not heavy atoms).
 * - rotatableProxy: count of acyclic single-bond separators. We count the
 *   number of explicit/implicit single bonds between two heavy atoms that
 *   are not inside a ring-closure pair. Cheap heuristic: every heavy-atom
 *   boundary that is not part of a double/triple/aromatic bond and not a
 *   ring-bond digit. Over-counts slightly, which is fine for a guard.
 */
export function estimateSmilesComplexity(smiles: string): SmilesComplexity {
  let heavyAtoms = 0;
  let rotatableProxy = 0;
  let i = 0;
  let prevWasHeavy = false;
  let pendingMultiBond = false; // last token was = or # (non-rotatable)
  const upperHalogenSecond = (c: string): boolean => c === 'l' || c === 'r';
  while (i < smiles.length) {
    const ch = smiles[i]!;
    if (ch === '[') {
      // Bracketed atom — consume to the matching ']' and count as one heavy
      // atom unless it is an explicit hydrogen atom `[H]`.
      const end = smiles.indexOf(']', i);
      const inner = end === -1 ? smiles.slice(i + 1) : smiles.slice(i + 1, end);
      const isHydrogen = /^\d*H\d*[+-]?\d*$/.test(inner.replace(/[@]/g, ''));
      if (!isHydrogen) {
        heavyAtoms++;
        if (prevWasHeavy && !pendingMultiBond) rotatableProxy++;
        prevWasHeavy = true;
      }
      pendingMultiBond = false;
      i = end === -1 ? smiles.length : end + 1;
      continue;
    }
    if (ch === '=' || ch === '#' || ch === ':') {
      pendingMultiBond = true; // double/triple/aromatic bond — not rotatable
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      // Organic-subset element. Two-letter halogens (Cl, Br) consume the
      // next char. Aromatic lowercase atoms count as heavy.
      let isHeavy = true;
      if (ch === 'H') isHeavy = false; // free H outside brackets is rare/invalid; skip
      if ((ch === 'C' || ch === 'B') && i + 1 < smiles.length && upperHalogenSecond(smiles[i + 1]!)) {
        i++; // Cl / Br — one heavy atom
      }
      if (isHeavy) {
        heavyAtoms++;
        if (prevWasHeavy && !pendingMultiBond) rotatableProxy++;
        prevWasHeavy = true;
      }
      pendingMultiBond = false;
      i++;
      continue;
    }
    // Ring-closure digits, branch open/close, charges, dots — these break
    // the "previous-was-heavy" rotatable chain so we don't double-count the
    // first atom after a branch as rotatable across the branch boundary.
    if (ch === '(' || ch === ')' || ch === '.') {
      prevWasHeavy = false;
      pendingMultiBond = false;
    }
    i++;
  }
  return { heavyAtoms, rotatableProxy };
}

/**
 * Bug 20 v4 (2026-05-23) — gate decision: should we skip obabel gen3d for
 * this ligand and go straight to the RDKit ETKDGv3 path? Returns a reason
 * string when the ligand exceeds either threshold, else null.
 */
export function shouldSkipObabelGen3d(smiles: string): string | null {
  const { heavyAtoms, rotatableProxy } = estimateSmilesComplexity(smiles);
  if (heavyAtoms > LIGAND_HEAVY_ATOM_GATE) {
    return `heavy-atom count ${heavyAtoms} > ${LIGAND_HEAVY_ATOM_GATE} gate`;
  }
  if (rotatableProxy > LIGAND_ROTATABLE_GATE) {
    return `rotatable-bond proxy ${rotatableProxy} > ${LIGAND_ROTATABLE_GATE} gate`;
  }
  return null;
}

export interface RunDockingOptions {
  /** Override binary names (mostly for tests). */
  vinaBin?: string;
  obabelBin?: string;
  /** Vina invocation timeout (per-WO). Defaults to DEFAULT_VINA_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Open Babel invocation timeout for both receptor protonation and
   * ligand `--gen3d`. Defaults to DEFAULT_OBABEL_TIMEOUT_MS (600s).
   * Test-only injection point.
   */
  obabelTimeoutMs?: number;
  /**
   * Bug 20 v4 (2026-05-23) — fast-tier per-attempt budget override
   * (test-only injection point). Defaults to DEFAULT_FAST_TIER_MS (90s),
   * clamped to half the total obabel budget.
   */
  fastTierMs?: number;
  /** Override the working directory (default: a fresh temp dir per WO). */
  workDir?: string;
  /** Override hardware reporting (mostly for tests). */
  hardwareReporter?: () => Promise<{ cpu: string; ramMb: number }>;
  /**
   * Test-only: stub for `runChild`. Allows unit tests to assert the
   * two-tier --gen3d retry path without spawning real obabel. NEVER
   * set in production code. See gen3d-retry.spec.ts.
   */
  __runChildForTests?: (bin: string, args: string[], opts: RunChildOpts) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Bug 20 v3 (2026-05-18) — RDKit tier-3 fallback timeout. Defaults to
   * 60s (RDKit ETKDGv3 typically finishes in <5s but pathological
   * ligands can take longer).
   */
  rdkitTimeoutMs?: number;
  /**
   * Bug 20 v3 (2026-05-18) — override path to the RDKit Python helper.
   * Default resolves from the package scripts/ dir. Tests inject a
   * stub script to avoid needing real RDKit.
   */
  rdkitScriptPath?: string;
  /**
   * Bug 20 v3 (2026-05-18) — override the python binary. Default
   * `python3` (override via PYTHON_BIN env). Tests inject `node` or a
   * shell stub.
   */
  pythonBin?: string;
}

export interface RunDockingInput {
  workOrderId: string;
  peerId: string;
  payload: DockingWorkOrderPayload;
}

export class DockingError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'DockingError';
  }
}

// ── Binary availability ─────────────────────────────────────────────────────

export async function assertBinariesAvailable(opts?: RunDockingOptions): Promise<void> {
  const vina = opts?.vinaBin ?? DEFAULT_VINA_BIN;
  const obabel = opts?.obabelBin ?? DEFAULT_OBABEL_BIN;
  await runChild(vina, ['--version'], { timeoutMs: 10_000 }).catch(() => {
    throw new DockingError(`Vina binary not found or unusable: ${vina}`, 'precheck');
  });
  await runChild(obabel, ['-V'], { timeoutMs: 10_000 }).catch(() => {
    throw new DockingError(`Open Babel binary not found or unusable: ${obabel}`, 'precheck');
  });
}

/**
 * Module-private cache for `isVinaAvailable`. Detection requires spawning
 * `vina --version` and `obabel -V` — non-trivial cost when called per
 * heartbeat tick (every 60 s). Same caching strategy as
 * `TrainerHelper.pyTorchCache`: ONLY cache positive detections. A
 * negative result (binary not yet on PATH, slow PATH lookup, transient
 * spawn failure) retries on the next heartbeat so a freshly-installed
 * Vina is picked up without a node restart.
 */
let vinaAvailableCache: boolean | null = null;

/**
 * Probe whether both Vina and Open Babel are available on this host.
 *
 * Used by the heartbeat capability builder to decide whether to advertise
 * the `docking` capability to the coordinator. The coordinator's
 * DockingDispatchCron skip-gates opening new MOLECULAR_DOCKING pairs
 * when zero online nodes advertise this cap — so if no node here
 * detects Vina, the coord will never open new pairs (the safe-by-default
 * behavior).
 *
 * Mirrors the contract of `assertBinariesAvailable`: BOTH binaries must
 * pass (`vina --version` + `obabel -V`) — Vina alone is useless without
 * Open Babel for ligand/receptor prep. Returns `false` (not throws) on
 * any failure: the heartbeat path must be non-fatal.
 *
 * @param opts Optional binary name overrides (tests inject stubs).
 */
export async function isVinaAvailable(opts?: RunDockingOptions): Promise<boolean> {
  if (vinaAvailableCache === true) return true;
  try {
    await assertBinariesAvailable(opts);
    vinaAvailableCache = true;
    return true;
  } catch {
    // Don't cache negatives — operator may install vina/obabel after node
    // boot, and we want the next heartbeat to pick it up.
    return false;
  }
}

/**
 * Test-only hook. Resets the module-private vinaAvailableCache so each
 * unit test starts from a clean slate. Production code never calls this.
 */
export function __resetVinaCacheForTests(): void {
  vinaAvailableCache = null;
}

// ── Receptor cache ──────────────────────────────────────────────────────────

async function ensureReceptorCached(pdbId: string): Promise<string> {
  const id = pdbId.toUpperCase();
  if (!/^[0-9A-Z]{4}$/.test(id)) {
    throw new DockingError(`Invalid PDB ID: ${pdbId}`, 'receptor');
  }
  await fs.promises.mkdir(RECEPTOR_CACHE_DIR, { recursive: true });
  const pdbPath = path.join(RECEPTOR_CACHE_DIR, `${id}.pdb`);
  if (await fileExists(pdbPath)) return pdbPath;

  const url = `https://files.rcsb.org/download/${id}.pdb`;
  logger.log(`[docking] Downloading receptor ${id} from ${url}`);
  await downloadFile(url, pdbPath);
  return pdbPath;
}

// ── Open Babel preparation steps ────────────────────────────────────────────

async function prepReceptorPdbqt(pdbPath: string, opts: RunDockingOptions): Promise<string> {
  const out = pdbPath.replace(/\.pdb$/, '.pdbqt');
  if (await fileExists(out)) return out;
  // -xr keeps only polar hydrogens; -p7.4 sets pH for protonation.
  // Shares the ligand `--gen3d` budget (DEFAULT_OBABEL_TIMEOUT_MS, 600s)
  // because big receptors (>500 residues) can also be slow under load
  // and there's no operational benefit to a separate cap. See Bug 20
  // (2026-05-17) for the rationale behind the 600s default.
  const timeoutMs = opts.obabelTimeoutMs ?? DEFAULT_OBABEL_TIMEOUT_MS;
  await runChild(opts.obabelBin ?? DEFAULT_OBABEL_BIN, [
    pdbPath, '-O', out, '-xr', '-p', '7.4',
  ], {
    timeoutMs,
    timeoutContext: { step: 'receptor-protonate', input: pdbPath },
    // Bug 20 v4 — receptor protonation is also CPU-bound obabel work; nice
    // it so it yields to concurrent torch training.
    nice: true,
  });
  return out;
}

async function prepLigandPdbqt(smiles: string, workDir: string, opts: RunDockingOptions): Promise<string> {
  const ligandSmiPath = path.join(workDir, 'ligand.smi');
  const ligandPdbqtPath = path.join(workDir, 'ligand.pdbqt');
  await fs.promises.writeFile(ligandSmiPath, smiles + '\n', 'utf8');
  const totalBudgetMs = opts.obabelTimeoutMs ?? DEFAULT_OBABEL_TIMEOUT_MS;
  // Bug 20 v4 (2026-05-23) — invert + shorten the tiers. The fast tier
  // runs FIRST with a tight budget (default 90s, never more than half the
  // total) so a pathological ligand falls through to RDKit / failure in
  // ~90s instead of the old ~600s. If the fast tier succeeds (the common
  // case for drug-like ligands) we never pay for med at all. The med tier
  // is the fallback now and gets whatever budget remains after fast — it
  // exists only for the rare ligand where fast produces a degenerate
  // conformer Vina then rejects (Vina exit, not a prep timeout). Total
  // wall budget unchanged (still ≤ totalBudgetMs).
  const fastTierMs = Math.min(
    opts.fastTierMs ?? DEFAULT_FAST_TIER_MS,
    Math.floor(totalBudgetMs / 2),
  );
  const medTierMs = Math.max(totalBudgetMs - fastTierMs, fastTierMs);
  const obabelBin = opts.obabelBin ?? DEFAULT_OBABEL_BIN;
  const spawn = opts.__runChildForTests ?? runChild;

  // Bug 20 v4 (2026-05-23) — complexity pre-filter (#3 root cause:
  // pathological ligands whose gen3d never converges). Estimate heavy-atom
  // count + rotatable-bond proxy straight from the SMILES string (no heavy
  // parse) and, when it exceeds a conservative gate, skip obabel gen3d
  // entirely and go straight to RDKit ETKDGv3 — which embeds large flexible
  // molecules in seconds. Saves the full obabel budget for the inputs most
  // likely to defeat it. If RDKit is unavailable here we fail fast with a
  // clear reason rather than burning the obabel budget on a known-doomed run.
  const skipReason = shouldSkipObabelGen3d(smiles);
  if (skipReason) {
    logger.warn(
      `[Docking] complexity pre-filter: skipping obabel gen3d (${skipReason}) — using RDKit ETKDGv3 directly`,
    );
    const rdkitOk = await tryRdkitFallback({
      smiles,
      workDir,
      ligandPdbqtPath,
      obabelBin,
      spawn,
      rdkitTimeoutMs: opts.rdkitTimeoutMs ?? 60_000,
      rdkitScriptPath: opts.rdkitScriptPath,
      pythonBin: opts.pythonBin,
      formatConvertTimeoutMs: 10_000,
    });
    if (rdkitOk) {
      logger.info(`[Docking] RDKit ETKDGv3 (pre-filter path) succeeded for WO smiles_len=${smiles.length}`);
      return ligandPdbqtPath;
    }
    // RDKit absent/failed and obabel was deemed too risky to attempt — fail
    // fast with a clear, timeout-shaped reason so the downstream per-WO
    // failure counter (submit-result.ts) treats it like the other gen3d
    // timeouts and the WO is released + skipped on subsequent polls.
    throw new DockingError(
      `Process timed out (pre-filter): ligand too complex for obabel gen3d (${skipReason}) and RDKit fallback unavailable`,
      'ligand',
    );
  }

  // Bug 20 v2 (2026-05-18): two-tier retry. Bug 20 v4 (2026-05-23): order
  // inverted to fast-first. Primary --gen3d fast (lower conformer quality
  // but ~5x faster, acceptable for Vina docking) with the short budget.
  // Fallback --gen3d med (best quality) on timeout with the remaining
  // budget. If BOTH obabel tiers time out, attempt the RDKit ETKDGv3
  // fallback. RDKit's experimental-torsion-knowledge embedding completes
  // in seconds for the same drug-like ligands that defeat obabel's
  // brute-force conformer search. If RDKit is absent or fails, we rethrow
  // the original timeout so the WO marks failed and the per-WO failure
  // counter increments.
  logger.info(`[Docking] ligand-prep WO smiles_len=${smiles.length} tier=obabel-fast timeoutMs=${fastTierMs}`);
  try {
    await spawn(obabelBin, [
      ligandSmiPath, '-O', ligandPdbqtPath, '--gen3d', 'fast', '-h',
    ], {
      timeoutMs: fastTierMs,
      timeoutContext: { step: 'ligand-gen3d-fast', input: smiles },
      nice: true,
    });
    return ligandPdbqtPath;
  } catch (err) {
    const isTimeout = err instanceof Error && /timed out/i.test(err.message);
    if (!isTimeout) throw err;
    // Fast tier timed out — fall back to med (better search heuristics may
    // converge where fast did not). Remove any partial output file from
    // the failed first attempt before retry.
    logger.warn(`[Docking] obabel --gen3d fast timed out after ${fastTierMs}ms — retrying with med tier`);
    await fs.promises.rm(ligandPdbqtPath, { force: true });
  }
  try {
    await spawn(obabelBin, [
      ligandSmiPath, '-O', ligandPdbqtPath, '--gen3d', 'med', '-h',
    ], {
      timeoutMs: medTierMs,
      timeoutContext: { step: 'ligand-gen3d-med-retry', input: smiles },
      nice: true,
    });
    return ligandPdbqtPath;
  } catch (err) {
    const isTimeout = err instanceof Error && /timed out/i.test(err.message);
    if (!isTimeout) throw err;
    // Both obabel tiers timed out — attempt RDKit tier-3 fallback.
    logger.warn(`[Docking] obabel --gen3d med timed out after ${medTierMs}ms — attempting RDKit tier-3 fallback`);
    await fs.promises.rm(ligandPdbqtPath, { force: true });
    const rdkitOk = await tryRdkitFallback({
      smiles,
      workDir,
      ligandPdbqtPath,
      obabelBin,
      spawn,
      rdkitTimeoutMs: opts.rdkitTimeoutMs ?? 60_000,
      rdkitScriptPath: opts.rdkitScriptPath,
      pythonBin: opts.pythonBin,
      formatConvertTimeoutMs: 10_000,
    });
    if (rdkitOk) {
      logger.info(`[Docking] RDKit tier-3 fallback succeeded for WO smiles_len=${smiles.length}`);
      return ligandPdbqtPath;
    }
    // RDKit unavailable or failed — rethrow the med-tier timeout so the
    // WO is marked failed. Per-WO failure counter increments downstream;
    // after the cap, the WO is locally skipped (Bug 20 v3).
    logger.warn('[Docking] RDKit tier-3 fallback unavailable or failed — propagating obabel timeout');
    throw err;
  }
}

/**
 * Bug 20 v3 (2026-05-18) — tier-3 RDKit ETKDGv3 ligand 3D conformer
 * generation. Returns true on success (ligand.pdbqt written), false on
 * any failure (RDKit not installed, embedding failure, format-convert
 * failure). NEVER throws — caller handles the fail-path by rethrowing
 * the upstream obabel timeout.
 *
 * Strategy:
 *   1. Run `python3 docking_rdkit_fallback.py <smiles> <work>/rdkit.pdb`.
 *      Exit code 4 = RDKit not installed; we log warn + return false.
 *      Exit codes 1-3 = invalid SMILES / embed / opt failure; we log
 *      warn + return false.
 *   2. Run `obabel rdkit.pdb -O ligand.pdbqt` (NO `--gen3d`, just
 *      format-convert). Completes in <1s. 10s budget.
 *
 * `rdkitScriptPath` defaults to the helper shipped with the node
 * package (scripts/docking_rdkit_fallback.py relative to this file's
 * dist location). Override for tests.
 */
async function tryRdkitFallback(args: {
  smiles: string;
  workDir: string;
  ligandPdbqtPath: string;
  obabelBin: string;
  spawn: (bin: string, argv: string[], opts: RunChildOpts) => Promise<{ stdout: string; stderr: string }>;
  rdkitTimeoutMs: number;
  rdkitScriptPath?: string;
  pythonBin?: string;
  formatConvertTimeoutMs: number;
}): Promise<boolean> {
  const pdbOut = path.join(args.workDir, 'rdkit.pdb');
  const python = args.pythonBin ?? process.env.PYTHON_BIN ?? 'python3';
  const scriptPath = args.rdkitScriptPath ?? resolveRdkitScriptPath();
  try {
    // Bug 0.8.90 L4 — pass `--` separator before SMILES so a hypothetical
    // leading-dash SMILES never gets parsed as an argparse option flag.
    // Real SMILES start with element letters / digits / `[`; this is a
    // defensive cheap guard, not a known live failure.
    const { stderr } = await args.spawn(
      python,
      [scriptPath, '--', args.smiles, pdbOut],
      {
        timeoutMs: args.rdkitTimeoutMs,
        timeoutContext: { step: 'ligand-rdkit-etkdg', input: args.smiles },
        // Bug 20 v4 — RDKit embedding is CPU-bound; nice it so it yields to
        // concurrent torch training (the #1 contention root cause).
        nice: true,
      },
    );
    if (stderr && stderr.trim()) {
      // Non-fatal stderr (RDKit prints warnings to stderr even on
      // success). Log info — the success/failure decision is on exit
      // code, surfaced by runChild rejecting on non-zero.
      logger.info(`[Docking] RDKit stderr: ${stderr.slice(0, 200)}`);
    }
  } catch (err) {
    logger.warn(`[Docking] RDKit ETKDGv3 step failed: ${(err as Error).message.slice(0, 200)}`);
    return false;
  }
  try {
    await args.spawn(
      args.obabelBin,
      [pdbOut, '-O', args.ligandPdbqtPath],
      {
        timeoutMs: args.formatConvertTimeoutMs,
        timeoutContext: { step: 'ligand-pdb-to-pdbqt', input: pdbOut },
        nice: true,
      },
    );
  } catch (err) {
    logger.warn(`[Docking] RDKit fallback format-convert (obabel pdb→pdbqt) failed: ${(err as Error).message.slice(0, 200)}`);
    return false;
  }
  return true;
}

/**
 * Resolve the path to `docking_rdkit_fallback.py`.
 *
 * The published package layout is:
 *   <pkg>/dist/index.js  (compiled, current __dirname)
 *   <pkg>/scripts/docking_rdkit_fallback.py
 *
 * In dev (`tsc --watch`), __dirname is `<pkg>/dist/.../docker.js`. In
 * production npm install, __dirname is `<pkg>/dist/index.js`. Walk up
 * from __dirname until we find a `scripts/` sibling. Falls back to a
 * cwd-relative path if walking fails so test environments work.
 */
function resolveRdkitScriptPath(): string {
  // Bug 0.8.90 L3 — deterministic first attempt for the common
  // npm-install layout: `<pkg>/dist/index.js` → `<pkg>/scripts/...`.
  // The compiled bundle lives at `<pkg>/dist/index.js`, so the script
  // is one `..` up from `__dirname`. This handles the published-package
  // case in O(1) before falling back to the walk-up search, which
  // covers nested monorepo + Tauri symlink layouts.
  const directGuess = path.join(__dirname, '..', 'scripts', 'docking_rdkit_fallback.py');
  if (existsSync(directGuess)) return directGuess;

  // Walk up from this module's directory looking for a `scripts` sibling.
  // 8 hops handles deep monorepo + symlinked workspaces (was 6 in 0.8.89,
  // bumped to 8 for Tauri sidecar layouts where the dist sits under
  // `src-tauri/binaries/<target-triple>/node/dist/...`).
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'scripts', 'docking_rdkit_fallback.py');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'scripts', 'docking_rdkit_fallback.py');
}

/**
 * Test-only: exposes `prepLigandPdbqt` for unit-testing the two-tier
 * --gen3d retry path (Bug 20 v2, 2026-05-18). Production code uses the
 * module-private function via `runDocking`. NEVER call from outside
 * tests.
 */
export async function __prepLigandPdbqtForTests(
  smiles: string,
  workDir: string,
  opts: RunDockingOptions,
): Promise<string> {
  return prepLigandPdbqt(smiles, workDir, opts);
}

// ── Vina invocation ─────────────────────────────────────────────────────────

async function runVina(args: {
  vinaBin: string;
  receptorPath: string;
  ligandPath: string;
  outPath: string;
  bindingSite: DockingWorkOrderPayload['bindingSite'];
  vinaParams: DockingWorkOrderPayload['vinaParams'];
  vinaSeed: string;
  timeoutMs: number;
}): Promise<void> {
  // Convert the hex seed to a positive 64-bit integer string. Vina takes a
  // signed 32-bit seed so we modulo into the int32 range, preserving
  // determinism (seed derived from pairId is the contract — both nodes
  // truncate identically).
  const seedInt = parseInt(args.vinaSeed.slice(0, 8), 16) % 2_147_483_647;

  const flags: string[] = [
    '--receptor', args.receptorPath,
    '--ligand', args.ligandPath,
    '--out', args.outPath,
    '--center_x', String(args.bindingSite.x),
    '--center_y', String(args.bindingSite.y),
    '--center_z', String(args.bindingSite.z),
    '--size_x', String(args.bindingSite.sizeX),
    '--size_y', String(args.bindingSite.sizeY),
    '--size_z', String(args.bindingSite.sizeZ),
    '--exhaustiveness', String(args.vinaParams.exhaustiveness),
    '--num_modes', String(args.vinaParams.num_modes),
    '--energy_range', String(args.vinaParams.energy_range),
    '--seed', String(seedInt),
    '--cpu', '4',
  ];
  await runChild(args.vinaBin, flags, { timeoutMs: args.timeoutMs });
}

// ── Top-level entry-point ───────────────────────────────────────────────────

export async function runDocking(
  input: RunDockingInput,
  options: RunDockingOptions = {},
): Promise<DockingSubmissionPayload> {
  const { workOrderId, peerId, payload } = input;
  const start = Date.now();

  await assertBinariesAvailable(options);

  const workDir = options.workDir ?? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-docking-'));
  let outPath = '';

  try {
    const receptorPdb = await ensureReceptorCached(payload.receptorPdbId);
    const receptorPdbqt = await prepReceptorPdbqt(receptorPdb, options);
    const ligandPdbqt = await prepLigandPdbqt(payload.ligandSmiles, workDir, options);
    outPath = path.join(workDir, 'out.pdbqt');

    await runVina({
      vinaBin: options.vinaBin ?? DEFAULT_VINA_BIN,
      receptorPath: receptorPdbqt,
      ligandPath: ligandPdbqt,
      outPath,
      bindingSite: payload.bindingSite,
      vinaParams: payload.vinaParams,
      vinaSeed: payload.vinaSeed,
      timeoutMs: options.timeoutMs ?? DEFAULT_VINA_TIMEOUT_MS,
    });

    const text = await fs.promises.readFile(outPath, 'utf8');
    const poses: DockingPose[] = parseVinaPdbqt(text);
    if (poses.length === 0) {
      throw new DockingError('Vina produced no poses', 'parse');
    }

    const bestAffinity = poses.reduce((acc, p) => Math.min(acc, p.affinity), Number.POSITIVE_INFINITY);
    const resultHash = 'sha256:' + createHash('sha256').update(text).digest('hex');
    const hardwareUsed = options.hardwareReporter
      ? await options.hardwareReporter()
      : { cpu: os.cpus()[0]?.model ?? 'unknown', ramMb: Math.round(os.totalmem() / (1024 * 1024)) };

    return {
      workOrderId, peerId,
      bestAffinity,
      poses,
      durationMs: Date.now() - start,
      vinaVersion: payload.vinaVersion,
      hardwareUsed,
      resultHash,
    };
  } finally {
    if (!options.workDir) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirected = res.headers.location;
        if (!redirected) return reject(new Error(`Redirect with no Location header: ${url}`));
        res.resume();
        downloadFile(redirected, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(err => err ? reject(err) : resolve()));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * Builds the timeout error message. Extracted so tests can assert the
 * exact shape (step, input, env-var hint) without spinning child
 * processes. Truncates SMILES/path to 200 chars so logs stay readable
 * for pathological-length inputs.
 */
export function buildObabelTimeoutMessage(args: {
  bin: string;
  cliArgs: string[];
  timeoutMs: number;
  step?: string;
  input?: string;
}): string {
  const truncatedInput = args.input && args.input.length > 200
    ? args.input.slice(0, 200) + '…'
    : args.input;
  const lines = [
    `Process timed out after ${args.timeoutMs}ms: ${args.bin} ${args.cliArgs.join(' ')}`,
  ];
  if (args.step) lines.push(`  step: ${args.step}`);
  if (truncatedInput) lines.push(`  input: ${truncatedInput}`);
  lines.push(
    '  hint: raise DOCKING_OBABEL_TIMEOUT_MS for complex drug-like ligands (Indinavir, Imatinib, etc.).',
  );
  return lines.join('\n');
}

/**
 * Bug 20 v4 (2026-05-23) — `nice` availability probe. Cached after first
 * resolution. We only ever wrap with `nice` on POSIX (Linux pods + macOS
 * dev). On Windows or if `nice` is somehow absent, the wrapper is dropped
 * and the child spawns at normal priority — the rest of the timeout/kill
 * machinery is unaffected, so this degrades gracefully (no hard dep on a
 * system binary). `existsSync` on the common paths is enough; we never
 * shell out to detect it.
 */
let niceBinCache: string | null | undefined;
function resolveNiceBin(): string | null {
  if (niceBinCache !== undefined) return niceBinCache;
  if (process.platform === 'win32') {
    niceBinCache = null;
    return null;
  }
  const override = process.env.DOCKING_NICE_BIN;
  if (override) {
    niceBinCache = existsSync(override) ? override : null;
    return niceBinCache;
  }
  niceBinCache = ['/usr/bin/nice', '/bin/nice'].find(existsSync) ?? null;
  return niceBinCache;
}

/** Test-only: reset the cached `nice` probe between specs. */
export function __resetNiceCacheForTests(): void {
  niceBinCache = undefined;
}

/**
 * Test-only: exposes the real `runChild` so the SIGTERM→SIGKILL escalation
 * and process-group reap can be exercised against a real (stubborn) child
 * without spawning obabel. Production code uses the module-private function.
 */
export function __runChildForTests(
  bin: string,
  args: string[],
  opts: RunChildOpts,
): Promise<{ stdout: string; stderr: string }> {
  return runChild(bin, args, opts);
}

function runChild(bin: string, args: string[], opts: RunChildOpts): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Bug 20 v4 — reduce CPU priority for prep spawns so they yield to
    // concurrent torch GPU training (the #1 contention root cause). Wrap
    // `<bin> <args>` as `nice -n 19 <bin> <args>` when requested AND `nice`
    // is available; otherwise spawn directly. Vina invocations never set
    // `opts.nice` — that is the work we are paid for and runs at normal
    // priority.
    const niceBin = opts.nice ? resolveNiceBin() : null;
    const spawnBin = niceBin ?? bin;
    const spawnArgs = niceBin ? ['-n', '19', bin, ...args] : args;
    // `detached: true` puts the child in its own process group so we can
    // signal the WHOLE group on timeout — obabel/RDKit may fork helper
    // subprocesses, and a bare `proc.kill` would orphan them as
    // CPU-burning zombies, defeating the timeout. We do NOT `unref()`:
    // the parent must stay attached to reap it.
    const proc = spawn(spawnBin, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let killGraceTimer: NodeJS.Timeout | undefined;
    let settled = false;
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Signal the child's whole process group when possible (negative PID =
    // process group, requires `detached`). Falls back to signalling just
    // the child if the group send fails (e.g. group already gone).
    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = proc.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try { proc.kill(signal); } catch { /* already dead */ }
      }
    };

    const timer = setTimeout(() => {
      // SIGTERM first (graceful), then escalate to SIGKILL after a short
      // grace if the child is still alive — obabel can ignore SIGTERM mid
      // conformer search and leave a zombie eating CPU after the "timeout".
      // Re-read the grace env at fire-time so tests can shorten it without
      // re-loading the module.
      const killGraceMs = parseKillGraceEnv();
      signalGroup('SIGTERM');
      killGraceTimer = setTimeout(() => {
        if (!settled) {
          logger.warn(`[Docking] child ${bin} ignored SIGTERM after ${killGraceMs}ms — sending SIGKILL`);
          signalGroup('SIGKILL');
        }
      }, killGraceMs);
      // Allow the process to exit even if this grace timer is pending.
      killGraceTimer.unref?.();
      reject(new Error(buildObabelTimeoutMessage({
        bin,
        cliArgs: args,
        timeoutMs: opts.timeoutMs,
        step: opts.timeoutContext?.step,
        input: opts.timeoutContext?.input,
      })));
    }, opts.timeoutMs);

    proc.on('error', err => {
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      reject(err);
    });
    proc.on('close', code => {
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// ── Test-only exports ──────────────────────────────────────────────────────

/**
 * Test-only: returns the resolved default obabel timeout. Production
 * code uses the module-private constant directly; tests assert against
 * this helper so a future env-var rewrite stays observable.
 */
export function __getDefaultObabelTimeoutMs(): number {
  return DEFAULT_OBABEL_TIMEOUT_MS;
}

/**
 * Test-only: re-parses DOCKING_OBABEL_TIMEOUT_MS at call time so tests
 * can mutate process.env and observe the new value without re-loading
 * the module.
 */
export function __resolveObabelTimeoutMsForTests(): number {
  return parseObabelTimeoutEnv();
}
