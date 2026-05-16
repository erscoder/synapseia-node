/**
 * Node-side LoRA validator runner (Plan 1 Phase 2).
 *
 * Pipeline (per LORA_VALIDATION WO):
 *   1. Precheck hardware (refuse LORA_GENERATION on Apple Silicon MPS — same
 *      defence-in-depth rule as `lora_trainer.ts:hasGpu`).
 *   2. Sandbox: create `<nodeHome>/lora-validation/<woId>/` and resolve every
 *      filename derived from `payload.*Uri` strictly INSIDE that root (P7).
 *   3. HEAD-check Content-Length BEFORE downloading the body. Reject adapter
 *      payloads over 200 MB and validation sets over 50 MB to bound disk +
 *      memory pressure (the trainer's hardware budget is small).
 *   4. Download adapter + validation set from `payload.*Uri`. The host MUST
 *      be on the allow-list `COORD_S3_ENDPOINTS` (env-configurable, defaults
 *      to a hard-coded list documented here). Fail-closed on host mismatch
 *      (P2) — never coerce an unknown host to "trusted".
 *   5. Verify sha256 against `payload.adapterSha256` / `payload.validationSetSha256`.
 *      Mismatch → throw `LoraValidationError` (P2 fail-closed; never default
 *      to "looks close enough").
 *   6. Spawn `python3 scripts/eval_lora.py` with the local file paths +
 *      metadata as a single-line JSON on stdin. Reuse the trainer's
 *      `runPython` pattern verbatim — same stdout-tap-to-logger, same
 *      stderr capture, same single-attempt-timeout. NO retry loop here;
 *      the coordinator re-assigns on transient failure.
 *   7. Read `<workDir>/metrics.json`, validate the shape against
 *      `LoraValMetrics` for the adapter's `subtype`. Refuse on missing
 *      subtype-required fields (P31: server-side fail-closed boundary).
 *   8. Sign `canonical({adapterId, validatorPeerId, observed})` with the
 *      node's Ed25519 identity key via `IdentityHelper.sign`. The wire
 *      format matches `LoraValidationResultDto` (coordinator Phase 3).
 *   9. Return `LoraValidationSubmissionPayload`. Best-effort cleanup of
 *      the sandbox in `finally`.
 *
 * Phase 2 scope: this runner only fires when `LORA_VALIDATOR_ENABLED=true`.
 * The CLI's `--lora-validator` flag flips that env var. Default is OFF.
 *
 * The Python eval script lives at `packages/node/scripts/eval_lora.py`
 * (created by the parallel AI Engineer agent — same stdin payload pattern
 * + metrics.json output convention as `train_lora.py`).
 *
 * P10 honesty: every claim above is enforced by code below. If a future
 * edit removes (e.g.) the host allow-list, update this header.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';
import { IdentityHelper } from '../identity/identity';
import type {
  LoraSubtype,
  LoraBaseModel,
  LoraValMetrics,
  LoraValidationWorkOrderPayload,
  LoraValidationSubmissionPayload,
} from './types';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.LORA_VAL_TIMEOUT_MS || '1800000', 10); // 30 min
// PYTHON_BIN env wins; otherwise resolve lazily (venv if present, else system).
function defaultPythonBin(): string {
  return process.env.PYTHON_BIN || resolvePython();
}
const MAX_ADAPTER_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_VAL_SET_BYTES = 50 * 1024 * 1024;  // 50 MB

/**
 * Default allow-list of artifact host suffixes. Coordinator-issued URIs
 * always resolve to one of these. Override via the env var
 * `COORD_S3_ENDPOINTS` (comma-separated). Empty entries are ignored.
 *
 * The defaults are intentionally LIBERAL prefixes ("amazonaws.com",
 * "synapseia.network") — host validation is a defence-in-depth layer; the
 * primary trust anchor remains the sha256 commitment in the WO payload.
 * P7 + P2: every download MUST pass both the allow-list AND the sha256
 * check; neither alone is sufficient.
 */
const DEFAULT_ALLOWED_HOST_SUFFIXES = [
  'amazonaws.com',
  's3.amazonaws.com',
  'synapseia.network',
  'cloudfront.net',
] as const;

function getAllowedHostSuffixes(): string[] {
  const env = process.env.COORD_S3_ENDPOINTS;
  if (!env) return [...DEFAULT_ALLOWED_HOST_SUFFIXES];
  const list = env.split(',').map(s => s.trim()).filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_ALLOWED_HOST_SUFFIXES];
}

export class LoraValidationError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'LoraValidationError';
  }
}

export interface RunLoraValidationOptions {
  pythonBin?: string;
  timeoutMs?: number;
  /** Override the sandbox root; default `<nodeHome>/lora-validation/<woId>/`. */
  workDir?: string;
  scriptPath?: string;
  /** Override the HEAD/GET pair (mostly for tests). */
  fetcher?: (url: string) => Promise<{
    contentLength: number | null;
    body: () => AsyncIterable<Uint8Array> | Promise<Buffer>;
  }>;
  /** Override the identity loader (mostly for tests). */
  identity?: { privateKeyHex: string; peerId: string };
  /** Override the signer (mostly for tests; default = IdentityHelper). */
  signer?: (message: string, privateKeyHex: string) => Promise<string>;
  /** Override hardware capability detection (mostly for tests). */
  forceGpu?: boolean;
  /** Override the metric emitter (mostly for tests). */
  metric?: (outcome: ValidationOutcome, context: Record<string, unknown>) => void;
}

export interface RunLoraValidationInput {
  workOrderId: string;
  /** Validator peerId — must match the runtime identity that signs. */
  peerId: string;
  payload: LoraValidationWorkOrderPayload;
}

/**
 * Stable label set for the `synapseia_node_lora_validations_total` counter.
 * The counter is emitted via a structured log line rather than prom-client
 * to avoid introducing a new runtime dependency (per
 * `feedback_workflow.md` / package.json discipline). Operators scrape the
 * log token `[lora-val-metric]`.
 */
export type ValidationOutcome = 'accepted' | 'rejected' | 'error' | 'timeout';

// ── Top-level entry ─────────────────────────────────────────────────────────

export async function runLoraValidation(
  input: RunLoraValidationInput,
  options: RunLoraValidationOptions = {},
): Promise<LoraValidationSubmissionPayload> {
  const { workOrderId, peerId, payload } = input;
  const metric = options.metric ?? defaultMetricEmitter;

  // 1. Precheck. Defence-in-depth on Apple Silicon MPS for generation eval.
  const hasHwGpu = options.forceGpu ?? hasGpu(payload.subtype);
  if (payload.subtype === 'LORA_GENERATION' && !hasHwGpu) {
    metric('rejected', { workOrderId, reason: 'no-gpu' });
    throw new LoraValidationError(
      `LORA_GENERATION validation (BioGPT-Large) requires a GPU; this node has none. Refusing to run on CPU.`,
      'precheck',
    );
  }

  // 2. Sandbox: derive a deterministic root inside <nodeHome>/lora-validation
  //    and validate the WO id is filesystem-safe before joining (P7).
  if (!isSafePathSegment(workOrderId)) {
    metric('rejected', { workOrderId, reason: 'unsafe-wo-id' });
    throw new LoraValidationError(`Refusing to run; workOrderId has unsafe characters: ${workOrderId}`, 'sandbox');
  }
  const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
  const workDir = options.workDir ?? path.join(nodeHome, 'lora-validation', workOrderId);
  const sandboxRoot = path.resolve(workDir);
  await fs.promises.mkdir(sandboxRoot, { recursive: true, mode: 0o700 });

  try {
    // 3 + 4 + 5. Fetch + sha256-verify both artifacts (adapter, val set).
    const adapterPath = await fetchAndVerify({
      url: payload.adapterUri,
      expectedSha256: payload.adapterSha256,
      maxBytes: MAX_ADAPTER_BYTES,
      destFilename: 'adapter_model.safetensors',
      sandboxRoot,
      fetcher: options.fetcher,
    });
    const valSetPath = await fetchAndVerify({
      url: payload.validationSetUri,
      expectedSha256: payload.validationSetSha256,
      maxBytes: MAX_VAL_SET_BYTES,
      destFilename: 'validation_set.jsonl',
      sandboxRoot,
      fetcher: options.fetcher,
    });

    // 6. Spawn the Python eval subprocess. Mirrors trainer's runPython.
    const scriptPath = options.scriptPath ?? resolveEvalScript();
    await assertFileExists(scriptPath, `Python LoRA eval script not found at ${scriptPath}`);

    await runPython(
      options.pythonBin ?? defaultPythonBin(),
      scriptPath,
      {
        adapterPath,
        validationSetPath: valSetPath,
        baseModel: payload.baseModel,
        subtype: payload.subtype,
        peerId,
        workOrderId,
        outDir: sandboxRoot,
      },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      { metric, workOrderId },
    );

    // 7. Read + shape-validate metrics.json.
    const metricsPath = path.join(sandboxRoot, 'metrics.json');
    await assertFileExists(metricsPath, 'Validator did not emit metrics.json');
    const metricsRaw = await fs.promises.readFile(metricsPath, 'utf8');
    let metrics: LoraValMetrics;
    try {
      metrics = JSON.parse(metricsRaw) as LoraValMetrics;
    } catch (err) {
      metric('error', { workOrderId, reason: 'metrics-parse', detail: (err as Error).message });
      throw new LoraValidationError(`metrics.json is not valid JSON: ${(err as Error).message}`, 'metrics');
    }
    assertMetricsShape(metrics, payload.subtype);

    // 8. Sign canonical envelope. Wire format mirrors LoraValidationResultDto.
    const identity = options.identity ?? loadIdentityForSigning();
    if (identity.peerId !== peerId) {
      // P2 fail-closed: never sign on behalf of a different peer.
      metric('error', { workOrderId, reason: 'identity-mismatch' });
      throw new LoraValidationError(
        `Identity peerId (${identity.peerId}) does not match runtime peerId (${peerId}); refusing to sign.`,
        'identity',
      );
    }
    const canonical = canonicalEnvelope({
      adapterId: payload.adapterId,
      validatorPeerId: peerId,
      observed: metrics,
    });
    const signer = options.signer ?? defaultSigner;
    const signature = await signer(canonical, identity.privateKeyHex);

    metric('accepted', { workOrderId, subtype: payload.subtype, metrics });

    return {
      adapterId: payload.adapterId,
      workOrderId,
      validatorPeerId: peerId,
      observed: metrics,
      signature,
    };
  } catch (err) {
    // Re-classify untyped errors as LoraValidationError so callers always
    // see a single error class. P2 — never let an unknown failure mode
    // bubble up as a generic Error and end up silently mis-handled by the
    // dispatch switch.
    if (err instanceof LoraValidationError) {
      // Only emit 'error' if a more specific outcome wasn't already emitted.
      if (err.stage === 'timeout') metric('timeout', { workOrderId });
      else if (
        err.stage !== 'precheck' &&
        err.stage !== 'sandbox' &&
        err.stage !== 'identity' &&
        err.stage !== 'metrics'
      ) {
        metric('error', { workOrderId, stage: err.stage, message: err.message });
      }
      throw err;
    }
    const e = err as Error;
    metric('error', { workOrderId, stage: 'unknown', message: e.message });
    throw new LoraValidationError(e.message, 'unknown');
  } finally {
    if (!options.workDir) {
      await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {
        /* best effort */
      });
    }
  }
}

// ── Download + verify ───────────────────────────────────────────────────────

interface FetchAndVerifyParams {
  url: string;
  expectedSha256: string;
  maxBytes: number;
  destFilename: string;
  sandboxRoot: string;
  fetcher?: RunLoraValidationOptions['fetcher'];
}

async function fetchAndVerify(p: FetchAndVerifyParams): Promise<string> {
  assertAllowedUrl(p.url);

  // P7: resolve destination INSIDE the sandbox root.
  if (!isSafePathSegment(p.destFilename)) {
    throw new LoraValidationError(`Refusing unsafe destination filename: ${p.destFilename}`, 'download');
  }
  const destAbs = path.resolve(p.sandboxRoot, p.destFilename);
  const rel = path.relative(p.sandboxRoot, destAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new LoraValidationError(`Destination escapes sandbox: ${destAbs}`, 'download');
  }

  const fetcher = p.fetcher ?? defaultFetcher;
  const head = await fetcher(p.url);
  // HEAD-equivalent: refuse OVERSIZED downloads BEFORE pulling the body.
  if (head.contentLength != null && head.contentLength > p.maxBytes) {
    throw new LoraValidationError(
      `Refusing download: ${p.url} reports Content-Length ${head.contentLength} bytes (cap ${p.maxBytes})`,
      'download',
    );
  }

  const buf = await collectBody(head.body, p.maxBytes);
  await fs.promises.writeFile(destAbs, buf, { mode: 0o600 });

  const sha = 'sha256:' + createHash('sha256').update(buf).digest('hex');
  if (sha !== normalizeSha(p.expectedSha256)) {
    // P2 fail-closed.
    throw new LoraValidationError(
      `sha256 mismatch for ${p.destFilename}: expected ${p.expectedSha256}, got ${sha}`,
      'sha256',
    );
  }
  return destAbs;
}

function normalizeSha(sha: string): string {
  return sha.startsWith('sha256:') ? sha : 'sha256:' + sha;
}

function assertAllowedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LoraValidationError(`Refusing malformed URL: ${url}`, 'download');
  }
  // Hard refuse non-https schemes — file://, ftp://, etc. are P7 traversal vectors.
  if (parsed.protocol !== 'https:') {
    throw new LoraValidationError(`Refusing non-https URL scheme: ${parsed.protocol}`, 'download');
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = getAllowedHostSuffixes();
  const ok = allowed.some(suffix => {
    const s = suffix.toLowerCase();
    return host === s || host.endsWith('.' + s);
  });
  if (!ok) {
    throw new LoraValidationError(
      `Refusing download from non-allow-listed host: ${host} (allow-list: ${allowed.join(', ')})`,
      'download',
    );
  }
}

async function collectBody(
  body: () => AsyncIterable<Uint8Array> | Promise<Buffer>,
  maxBytes: number,
): Promise<Buffer> {
  const out = await body();
  if (Buffer.isBuffer(out)) {
    if (out.length > maxBytes) {
      throw new LoraValidationError(`Body exceeded cap (${out.length} > ${maxBytes})`, 'download');
    }
    return out;
  }
  // Streaming path: cap bytes mid-stream so we never write more than allowed.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of out as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new LoraValidationError(`Body exceeded cap (${total} > ${maxBytes})`, 'download');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const defaultFetcher: NonNullable<RunLoraValidationOptions['fetcher']> = async (url) => {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new LoraValidationError(`HTTP ${res.status} ${res.statusText} fetching ${url}`, 'download');
  }
  const lenHeader = res.headers.get('content-length');
  const contentLength = lenHeader ? parseInt(lenHeader, 10) : null;
  return {
    contentLength: Number.isFinite(contentLength as number) ? (contentLength as number) : null,
    body: async () => Buffer.from(await res.arrayBuffer()),
  };
};

// ── Hardware / paths ─────────────────────────────────────────────────────────

function hasGpu(subtype?: LoraSubtype): boolean {
  if (process.env.SYN_FORCE_GPU === 'true') return true;
  if (process.env.SYN_FORCE_NO_GPU === 'true') return false;
  const platform = os.platform();
  if (platform === 'darwin' && os.arch() === 'arm64') {
    // Mirror trainer: MPS allowed for CLASSIFICATION only.
    return subtype !== 'LORA_GENERATION';
  }
  return false;
}

function isSafePathSegment(seg: string): boolean {
  if (!seg || seg.length === 0 || seg.length > 200) return false;
  if (seg.includes('/') || seg.includes('\\') || seg.includes('\0')) return false;
  if (seg === '.' || seg === '..') return false;
  // Conservative allow-list: word chars, hyphen, dot, underscore.
  return /^[A-Za-z0-9._-]+$/.test(seg);
}

function resolveEvalScript(): string {
  // Mirrors `lora_trainer.ts:resolveTrainScript`. Script lives at
  // `packages/node/scripts/eval_lora.py`. tsup injects __filename per CJS
  // chunk; fall back to cwd if unavailable (e.g. ESM dev path).
  const moduleDir = (() => {
    try {
      // @ts-ignore — tsup banner injects __filename in CJS chunks.
      if (typeof __filename !== 'undefined') return path.dirname(__filename);
    } catch {
      /* fall through */
    }
    return process.cwd();
  })();
  const candidates = [
    path.resolve(moduleDir, '..', 'scripts', 'eval_lora.py'),
    path.resolve(moduleDir, '..', '..', 'scripts', 'eval_lora.py'),
    path.resolve(moduleDir, '..', '..', '..', 'scripts', 'eval_lora.py'),
    path.resolve(process.cwd(), 'scripts', 'eval_lora.py'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

async function assertFileExists(p: string, msg: string): Promise<void> {
  try {
    await fs.promises.access(p);
  } catch {
    throw new LoraValidationError(msg, 'fs');
  }
}

// ── Subprocess ───────────────────────────────────────────────────────────────

interface RunPythonHooks {
  metric: (outcome: ValidationOutcome, context: Record<string, unknown>) => void;
  workOrderId: string;
}

function runPython(
  bin: string,
  script: string,
  payload: object,
  timeoutMs: number,
  hooks: RunPythonHooks,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '4',
      },
    });
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      const txt = d.toString().trim();
      if (txt) logger.log(`[lora-val] ${txt}`);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    proc.stdin?.write(JSON.stringify(payload) + '\n');
    proc.stdin?.end();

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* noop */
      }
      hooks.metric('timeout', { workOrderId: hooks.workOrderId, timeoutMs });
      reject(new LoraValidationError(`LoRA validator timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new LoraValidationError(err.message, 'spawn'));
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new LoraValidationError(
            `python3 eval_lora.py exited with code ${code}: ${stderr.slice(0, 800)}`,
            'python',
          ),
        );
      }
    });
  });
}

// ── Metrics shape ────────────────────────────────────────────────────────────

function assertMetricsShape(metrics: LoraValMetrics, subtype: LoraSubtype): void {
  // P31-style: required fields per subtype. Refuse if the validator emitted
  // a metric outside the documented shape.
  if (subtype === 'LORA_CLASSIFICATION') {
    if (typeof metrics.accuracy !== 'number' || typeof metrics.f1 !== 'number') {
      throw new LoraValidationError(
        `LORA_CLASSIFICATION requires both accuracy and f1; got ${JSON.stringify(metrics)}`,
        'metrics',
      );
    }
    if (!isFinite01(metrics.accuracy) || !isFinite01(metrics.f1)) {
      throw new LoraValidationError(
        `LORA_CLASSIFICATION metrics out of range [0,1]: ${JSON.stringify(metrics)}`,
        'metrics',
      );
    }
  } else if (subtype === 'LORA_GENERATION') {
    if (typeof metrics.perplexity !== 'number' || !(metrics.perplexity > 0)) {
      throw new LoraValidationError(
        `LORA_GENERATION requires positive perplexity; got ${JSON.stringify(metrics)}`,
        'metrics',
      );
    }
    if (metrics.perplexity > 1e6) {
      throw new LoraValidationError(
        `LORA_GENERATION perplexity ${metrics.perplexity} exceeds sanity cap 1e6`,
        'metrics',
      );
    }
  } else {
    // Defensive — narrowing should make this unreachable, but never trust.
    throw new LoraValidationError(`Unsupported subtype: ${subtype}`, 'metrics');
  }
}

function isFinite01(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

// ── Canonical signing envelope ───────────────────────────────────────────────

interface CanonicalInput {
  adapterId: string;
  validatorPeerId: string;
  observed: LoraValMetrics;
}

/**
 * Canonical JSON for signing. Keys sorted alphabetically at every level so
 * `verify(canonical(x))` is deterministic on both sides. Mirrors
 * `IdentityHelper.canonicalPayload` semantics but typed for the validator
 * envelope.
 */
function canonicalEnvelope(input: CanonicalInput): string {
  const sortedObserved: Record<string, number> = {};
  for (const k of Object.keys(input.observed).sort()) {
    const v = (input.observed as Record<string, number | undefined>)[k];
    if (typeof v === 'number') sortedObserved[k] = v;
  }
  const env = {
    adapterId: input.adapterId,
    observed: sortedObserved,
    validatorPeerId: input.validatorPeerId,
  };
  return JSON.stringify(env);
}

function loadIdentityForSigning(): { privateKeyHex: string; peerId: string } {
  // Reuse IdentityHelper.loadIdentity. Synchronous because the helper is.
  const helper = new IdentityHelper();
  const id = helper.loadIdentity();
  return { privateKeyHex: id.privateKey, peerId: id.peerId };
}

async function defaultSigner(message: string, privateKeyHex: string): Promise<string> {
  return new IdentityHelper().sign(message, privateKeyHex);
}

// ── Metric emitter ───────────────────────────────────────────────────────────

/**
 * Default Prometheus-style counter emission. Operators scrape the log
 * token `[lora-val-metric]` to derive
 * `synapseia_node_lora_validations_total{outcome=...}`. Using a structured
 * log line instead of pulling in prom-client avoids a new runtime dep
 * (see `feedback_workflow.md` — no new deps without operator sign-off).
 * The label set is closed: outcome ∈ {accepted, rejected, error, timeout}.
 */
function defaultMetricEmitter(outcome: ValidationOutcome, context: Record<string, unknown>): void {
  try {
    logger.log(`[lora-val-metric] outcome=${outcome} ${JSON.stringify(context)}`);
  } catch {
    /* best effort */
  }
}

// ── Exports for testing ──────────────────────────────────────────────────────

export const __internal = {
  canonicalEnvelope,
  assertMetricsShape,
  assertAllowedUrl,
  isSafePathSegment,
  getAllowedHostSuffixes,
  resolveEvalScript,
  MAX_ADAPTER_BYTES,
  MAX_VAL_SET_BYTES,
};

// Re-export base types for convenience.
export type { LoraValidationWorkOrderPayload, LoraValidationSubmissionPayload, LoraSubtype, LoraBaseModel };
