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
  // --gen3d builds a 3D conformer from SMILES; -h adds explicit hydrogens.
  // 600s default (Bug 20, 2026-05-17): drug-like ligands like Indinavir
  // (HIV-1 Protease) and Imatinib (BCR-ABL) with many rotatable bonds
  // can take 5-10 min on a CPU under load. Operators can raise via
  // DOCKING_OBABEL_TIMEOUT_MS for even more complex molecules.
  const timeoutMs = opts.obabelTimeoutMs ?? DEFAULT_OBABEL_TIMEOUT_MS;
  await runChild(opts.obabelBin ?? DEFAULT_OBABEL_BIN, [
    ligandSmiPath, '-O', ligandPdbqtPath, '--gen3d', '-h',
  ], {
    timeoutMs,
    timeoutContext: { step: 'ligand-gen3d', input: smiles },
  });
  return ligandPdbqtPath;
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

interface RunChildOpts {
  timeoutMs: number;
  /** Diagnostic context surfaced when the timeout fires. */
  timeoutContext?: { step?: string; input?: string };
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
