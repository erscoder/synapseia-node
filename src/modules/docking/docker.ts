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
 * Default timeout for Open Babel `--gen3d` ligand prep and receptor
 * protonation. Bumped 180s → 600s (10 min) after Bug 20 (2026-05-17):
 * pod fleet observed legitimate drug-like ligands (Indinavir,
 * Imatinib, etc.) regularly exceeding 180s on `obabel ligand.smi -O
 * ligand.pdbqt --gen3d -h`. 3D conformer generation with explicit
 * hydrogens on rotatable-bond-heavy molecules can take 5-10 min on a
 * busy CPU — 600s is the measured worst-case observed in pod logs.
 *
 * Override via `DOCKING_OBABEL_TIMEOUT_MS` env var when running on
 * slower hardware or with even more complex ligands. parseInt
 * tolerates trailing garbage; NaN/0 falls back to the default.
 */
function parseObabelTimeoutEnv(): number {
  const raw = process.env.DOCKING_OBABEL_TIMEOUT_MS;
  if (!raw) return 600_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}
const DEFAULT_OBABEL_TIMEOUT_MS = parseObabelTimeoutEnv();

interface RunChildOpts {
  timeoutMs: number;
  /** Diagnostic context surfaced when the timeout fires. */
  timeoutContext?: { step?: string; input?: string };
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
  });
  return out;
}

async function prepLigandPdbqt(smiles: string, workDir: string, opts: RunDockingOptions): Promise<string> {
  const ligandSmiPath = path.join(workDir, 'ligand.smi');
  const ligandPdbqtPath = path.join(workDir, 'ligand.pdbqt');
  await fs.promises.writeFile(ligandSmiPath, smiles + '\n', 'utf8');
  const totalBudgetMs = opts.obabelTimeoutMs ?? DEFAULT_OBABEL_TIMEOUT_MS;
  const perTierMs = Math.floor(totalBudgetMs / 2);

  // Bug 20 v2 (2026-05-18): two-tier retry. Primary --gen3d med (best
  // conformer quality, slowest); fallback --gen3d fast on timeout (lower
  // quality but ~5x faster, still acceptable for Vina docking).
  // Total wall budget unchanged from Bug 20 (600s default).
  // Bug 20 v3 (2026-05-18): if BOTH obabel tiers time out, attempt the
  // RDKit ETKDGv3 fallback (Python helper at scripts/docking_rdkit_fallback.py).
  // RDKit's experimental-torsion-knowledge embedding completes in seconds
  // for the same drug-like ligands that defeat obabel's brute-force
  // conformer search. If RDKit is absent or fails, we rethrow the
  // original fast-tier timeout so the WO marks failed and the per-WO
  // failure counter increments. Total wall budget remains the same
  // (no new minutes spent on top of the obabel tiers).
  const obabelBin = opts.obabelBin ?? DEFAULT_OBABEL_BIN;
  const spawn = opts.__runChildForTests ?? runChild;
  logger.info(`[Docking] ligand-prep WO smiles_len=${smiles.length} tier=obabel-med timeoutMs=${perTierMs}`);
  try {
    await spawn(obabelBin, [
      ligandSmiPath, '-O', ligandPdbqtPath, '--gen3d', 'med', '-h',
    ], {
      timeoutMs: perTierMs,
      timeoutContext: { step: 'ligand-gen3d-med', input: smiles },
    });
    return ligandPdbqtPath;
  } catch (err) {
    const isTimeout = err instanceof Error && /timed out/i.test(err.message);
    if (!isTimeout) throw err;
    // Med tier timed out — fall back to fast. Remove any partial output
    // file from the failed first attempt before retry.
    logger.warn(`[Docking] obabel --gen3d med timed out after ${perTierMs}ms — retrying with fast tier`);
    await fs.promises.rm(ligandPdbqtPath, { force: true });
  }
  try {
    await spawn(obabelBin, [
      ligandSmiPath, '-O', ligandPdbqtPath, '--gen3d', 'fast', '-h',
    ], {
      timeoutMs: perTierMs,
      timeoutContext: { step: 'ligand-gen3d-fast-retry', input: smiles },
    });
    return ligandPdbqtPath;
  } catch (err) {
    const isTimeout = err instanceof Error && /timed out/i.test(err.message);
    if (!isTimeout) throw err;
    // Both obabel tiers timed out — attempt RDKit tier-3 fallback.
    logger.warn(`[Docking] obabel --gen3d fast timed out after ${perTierMs}ms — attempting RDKit tier-3 fallback`);
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
    // RDKit unavailable or failed — rethrow the fast-tier timeout so the
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

function runChild(bin: string, args: string[], opts: RunChildOpts): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      reject(new Error(buildObabelTimeoutMessage({
        bin,
        cliArgs: args,
        timeoutMs: opts.timeoutMs,
        step: opts.timeoutContext?.step,
        input: opts.timeoutContext?.input,
      })));
    }, opts.timeoutMs);
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
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
