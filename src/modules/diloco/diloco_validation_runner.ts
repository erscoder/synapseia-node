/**
 * Node-side DiLoCo B-validator runner (Phase 4B).
 *
 * The validator is a SECOND, independent check on a DiLoCo outer round: for
 * EACH surviving peer it applies THAT peer's raw per-peer pseudo-gradient on
 * top of prevAdapter (in isolation — no momentum, no stake-weighting, no
 * averaging) and forward-passes the held-out set, yielding that peer's
 * INDIVIDUAL held-out cross-entropy. This is per-peer-in-isolation by design:
 * it is NOT a re-score of the aggregator's stake-weighted + Nesterov merged
 * update. The resulting per-peer valLoss feeds the Phase-5 blend-ranking
 * (per-peer cosine alignment + per-peer valLoss quality). It mirrors
 * `diloco_aggregation_runner.ts`'s download→verify→spawn→sign→POST template
 * (same testable IO seams) but the compute is a real forward pass
 * (`diloco_validate.py`), NOT the synthetic `train_loss * 1.05` heuristic.
 *
 * Pipeline (per DILOCO_VALIDATION WO):
 *   1. Parse + validate the WO payload (§4A contract):
 *        { roundId, domain, outerRound, modelId,
 *          prevAdapter: {s3Key, sha256, downloadUrl} | null,
 *          gradients: [{peerId, s3Key, sha256, downloadUrl}],
 *          valSet: {downloadUrl, sha256, sampleCount},
 *          deadlineMs }
 *   2. Sandbox `<nodeHome>/diloco-validation/<woId>/`; every filename
 *      resolved strictly INSIDE that root (P7).
 *   3. Download prevAdapter (when present) + EVERY gradient + the held-out
 *      valSet via the coord-PRESIGNED GET URL (`downloadUrl`) — plain HTTP,
 *      NO AWS creds. sha256-verify each downloaded buffer against the pinned
 *      sha256 (P2 fail-closed — abort on ANY mismatch; the URL only proves
 *      the coord presigned the object, the sha256 is the integrity gate).
 *      A 403/expired URL surfaces a typed HTTP error → abort (P35).
 *   4. Spawn `diloco_validate.py` on CPU (CUDA_VISIBLE_DEVICES='') with the
 *      local paths on stdin; parse its single-line `{perPeerValLoss}` JSON.
 *      A peer the script could not evaluate is the literal STRING `"NaN"`.
 *   5. Build `validatorPeerId = identity.peerId` (== this node's identity ==
 *      the signer; P2 fail-closed cross-check). Sign
 *      `canonicalJSON({perPeerValLoss, roundId})` with the node's Ed25519
 *      key (body content signature the coord re-verifies). Then POST
 *      `POST /diloco/:domain/validation-result` with body EXACTLY:
 *        { roundId, validatorPeerId, perPeerValLoss, signature }
 *      (NO validatorWallet — the coord resolves it from peerId). The
 *      transport `X-Signature` header (NodeSignatureGuard) is built over the
 *      FULL posted body INCLUDING `signature` (sign body field FIRST, then
 *      assemble, then auth header — same ordering trap as the aggregation
 *      reveal).
 *
 * Fail-closed everywhere (P2): HTTP non-2xx (incl. 403/expired URL), sha256
 * mismatch, script non-zero exit / no JSON, identity mismatch → throw
 * `DiLoCoValidationError`. The node holds NO AWS creds — all S3 reads are via
 * the coord-presigned URLs in the WO payload.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';
import { sanitizedEnvForSubprocess } from '../../utils/subprocess-env';
import { IdentityHelper } from '../identity/identity';
import { buildAuthHeaders } from '../../utils/node-auth';
import { canonicalJSON } from './diloco-aggregation-commitment';
import {
  createDiLoCoAggregationHttpIO,
  sha256OfBuffer,
  type DiLoCoAggregationHttpIO,
} from './diloco-aggregation-http';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.DILOCO_VAL_TIMEOUT_MS || '1800000', 10); // 30 min
// Canonical held-out forward-pass sequence length. Pinned to `diloco_train.py`'s
// trainer Dataset `max_length=512` (and `diloco_validate.py`'s DEFAULT_MAX_SEQ_LEN)
// so the validator tokenizes the held-out set with the SAME bound the trainer
// used — a deterministic, source-aligned sequence length (no payload field
// carries it; 512 is the single canonical default across train/validate).
const DILOCO_VAL_MAX_SEQ_LEN = 512;
const MAX_GRADIENT_BYTES = 256 * 1024 * 1024; // 256 MB per pinned gradient (~92 MB typical)
const MAX_ADAPTER_BYTES = 256 * 1024 * 1024; // 256 MB prev adapter
const MAX_VAL_SET_BYTES = 64 * 1024 * 1024; // 64 MB held-out val set

export class DiLoCoValidationError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'DiLoCoValidationError';
  }
}

/** A pinned input: presigned GET URL + s3Key + sha256 the node verifies. */
export interface DiLoCoValidationGradient {
  peerId: string;
  s3Key: string;
  sha256: string;
  downloadUrl: string;
}

/** DILOCO_VALIDATION WO payload (§4A coord → node contract). */
export interface DiLoCoValidationWorkOrderPayload {
  roundId: string;
  domain: string;
  outerRound: number;
  modelId: string;
  /** Round 0 → null (cold-start: validate against the fresh LoRA adapter). */
  prevAdapter: { s3Key: string; sha256: string; downloadUrl: string } | null;
  gradients: DiLoCoValidationGradient[];
  /** Held-out validation set — presigned GET + pinned sha256 + sample count. */
  valSet: { downloadUrl: string; sha256: string; sampleCount: number };
  deadlineMs: number;
}

/** Raw stdout shape emitted by `diloco_validate.py`. */
interface ScriptOutput {
  perPeerValLoss?: Record<string, number | 'NaN'>;
  error?: string;
  errorType?: string;
}

interface ScriptInput {
  modelId: string;
  prevAdapterPath: string | null;
  valSetPath: string;
  peers: Array<{ peerId: string; gradientPath: string }>;
  maxValSamples: number;
  /** Held-out forward-pass sequence length (canonical 512, == trainer default). */
  maxSeqLen: number;
}

export interface RunDiLoCoValidationInput {
  workOrderId: string;
  /** This node's peerId — becomes `validatorPeerId`; MUST match the signer. */
  peerId: string;
  coordinatorUrl: string;
  payload: DiLoCoValidationWorkOrderPayload;
}

export interface RunDiLoCoValidationOptions {
  pythonBin?: string;
  timeoutMs?: number;
  workDir?: string;
  scriptPath?: string;
  /** Override the presigned-URL HTTP I/O (tests). Default = real axios IO. */
  httpIO?: DiLoCoAggregationHttpIO;
  /** Override the identity loader (tests). */
  identity?: LoadedIdentity;
  /** Override the spawn-and-collect (tests). Returns parsed script stdout. */
  runScript?: (paths: ScriptInput, timeoutMs: number) => Promise<ScriptOutput>;
  /** Override fetch (tests). */
  httpPost?: (
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/** The exact result the runner returns to the caller (and POSTs sans header). */
export interface DiLoCoValidationSubmission {
  roundId: string;
  validatorPeerId: string;
  perPeerValLoss: Record<string, number | 'NaN'>;
  signature: string;
}

interface LoadedIdentity {
  privateKeyHex: string;
  publicKeyHex: string;
  peerId: string;
}

// ── Top-level entry ──────────────────────────────────────────────────────────

export async function runDiLoCoValidation(
  input: RunDiLoCoValidationInput,
  options: RunDiLoCoValidationOptions = {},
): Promise<DiLoCoValidationSubmission> {
  const { workOrderId, peerId, coordinatorUrl, payload } = input;

  validatePayload(payload);

  const httpIO = options.httpIO ?? createDiLoCoAggregationHttpIO();

  if (!isSafePathSegment(workOrderId)) {
    throw new DiLoCoValidationError(`Unsafe workOrderId: ${workOrderId}`, 'sandbox');
  }
  if (!isSafePathSegment(peerId)) {
    throw new DiLoCoValidationError(`Unsafe peerId: ${peerId}`, 'sandbox');
  }

  const identity = options.identity ?? loadIdentity();
  // P2 fail-closed: never sign / attribute a result on behalf of another peer.
  if (identity.peerId !== peerId) {
    throw new DiLoCoValidationError(
      `Identity peerId (${identity.peerId}) != runtime peerId (${peerId}); refusing to validate.`,
      'identity',
    );
  }
  const validatorPeerId = peerId;

  const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
  const workDir = options.workDir ?? path.join(nodeHome, 'diloco-validation', workOrderId);
  const sandboxRoot = path.resolve(workDir);
  await fs.promises.mkdir(sandboxRoot, { recursive: true, mode: 0o700 });

  try {
    // 3. Download + sha256-verify every pinned input (P2 fail-closed).
    const peers: Array<{ peerId: string; gradientPath: string }> = [];
    for (let i = 0; i < payload.gradients.length; i++) {
      const g = payload.gradients[i];
      const dest = await downloadAndVerify(
        httpIO,
        g.downloadUrl,
        g.s3Key,
        g.sha256,
        MAX_GRADIENT_BYTES,
        sandboxRoot,
        `gradient_${i}.pt`,
      );
      peers.push({ peerId: g.peerId, gradientPath: dest });
    }

    let prevAdapterPath: string | null = null;
    if (payload.prevAdapter) {
      prevAdapterPath = await downloadAndVerify(
        httpIO,
        payload.prevAdapter.downloadUrl,
        payload.prevAdapter.s3Key,
        payload.prevAdapter.sha256,
        MAX_ADAPTER_BYTES,
        sandboxRoot,
        'prev_adapter.pkl',
      );
    }

    const valSetPath = await downloadAndVerify(
      httpIO,
      payload.valSet.downloadUrl,
      'valSet',
      payload.valSet.sha256,
      MAX_VAL_SET_BYTES,
      sandboxRoot,
      'val_set.jsonl',
    );

    // 4. Run the CPU-pinned validation script.
    const scriptInput: ScriptInput = {
      modelId: payload.modelId,
      prevAdapterPath,
      valSetPath,
      peers,
      maxValSamples: payload.valSet.sampleCount,
      maxSeqLen: DILOCO_VAL_MAX_SEQ_LEN,
    };
    const runScript = options.runScript ?? ((p, t) => defaultRunScript(p, t, options));
    const out = await runScript(scriptInput, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (out.error) {
      throw new DiLoCoValidationError(
        `validation script failed [${out.errorType ?? 'Error'}]: ${out.error}`,
        'script',
      );
    }
    if (!out.perPeerValLoss || typeof out.perPeerValLoss !== 'object') {
      throw new DiLoCoValidationError('validation script emitted no perPeerValLoss map', 'script');
    }
    const perPeerValLoss = normalizePerPeerValLoss(out.perPeerValLoss);

    // 5. Sign the body content signature over canonicalJSON({perPeerValLoss,
    //    roundId}) (the coord re-verifies this), then POST.
    const signature = await signResult(perPeerValLoss, payload.roundId, identity);
    await postResult(coordinatorUrl, payload, identity, {
      roundId: payload.roundId,
      validatorPeerId,
      perPeerValLoss,
      signature,
    }, options);

    logger.log(
      `[diloco-val] round=${payload.roundId} validator=${validatorPeerId.slice(0, 12)}… ` +
      `posted perPeerValLoss for ${Object.keys(perPeerValLoss).length} peers ` +
      `(NaN=${Object.values(perPeerValLoss).filter((v) => v === 'NaN').length})`,
    );

    return { roundId: payload.roundId, validatorPeerId, perPeerValLoss, signature };
  } finally {
    if (!options.workDir) {
      await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {
        /* best effort */
      });
    }
  }
}

// ── Payload validation ─────────────────────────────────────────────────────────

function validatePayload(p: DiLoCoValidationWorkOrderPayload): void {
  if (!p || typeof p !== 'object') throw new DiLoCoValidationError('payload is not an object', 'payload');
  if (!p.roundId || typeof p.roundId !== 'string') throw new DiLoCoValidationError('roundId required', 'payload');
  if (!p.domain || !/^[a-z0-9_-]{1,64}$/.test(p.domain)) {
    throw new DiLoCoValidationError(`domain must match /^[a-z0-9_-]{1,64}$/: ${p.domain}`, 'payload');
  }
  if (!Number.isInteger(p.outerRound) || p.outerRound < 0) {
    throw new DiLoCoValidationError('outerRound must be a non-negative integer', 'payload');
  }
  if (!p.modelId || typeof p.modelId !== 'string') {
    throw new DiLoCoValidationError('modelId required', 'payload');
  }
  if (!Array.isArray(p.gradients) || p.gradients.length === 0) {
    throw new DiLoCoValidationError('gradients must be a non-empty array', 'payload');
  }
  for (const g of p.gradients) {
    if (!g || typeof g.peerId !== 'string' || typeof g.s3Key !== 'string') {
      throw new DiLoCoValidationError('each gradient needs peerId + s3Key', 'payload');
    }
    if (!isHex64(g.sha256)) {
      throw new DiLoCoValidationError(`gradient sha256 must be 64-char hex: ${g.peerId}`, 'payload');
    }
    if (!isHttpUrl(g.downloadUrl)) {
      throw new DiLoCoValidationError(`gradient downloadUrl must be an http(s) URL: ${g.peerId}`, 'payload');
    }
  }
  if (p.prevAdapter && (!p.prevAdapter.s3Key || !isHex64(p.prevAdapter.sha256) || !isHttpUrl(p.prevAdapter.downloadUrl))) {
    throw new DiLoCoValidationError(
      'prevAdapter, when present, needs s3Key + 64-char hex sha256 + http(s) downloadUrl',
      'payload',
    );
  }
  if (!p.valSet || !isHex64(p.valSet.sha256) || !isHttpUrl(p.valSet.downloadUrl)) {
    throw new DiLoCoValidationError(
      'valSet needs a 64-char hex sha256 + http(s) downloadUrl',
      'payload',
    );
  }
  if (!Number.isInteger(p.valSet.sampleCount) || p.valSet.sampleCount <= 0) {
    throw new DiLoCoValidationError('valSet.sampleCount must be a positive integer', 'payload');
  }
}

// ── Per-peer valLoss normalization ───────────────────────────────────────────

/**
 * Normalize the script's `perPeerValLoss` so the value is ALWAYS a finite
 * number OR the literal STRING `"NaN"` — never a bare JS NaN / Infinity / a
 * stray type. The coord's body-content signature is over
 * `canonicalJSON({perPeerValLoss, roundId})`, so the exact bytes matter:
 * a finite number serializes as a number, an unparseable / non-finite value
 * collapses to the `"NaN"` string sentinel (P22 / contract).
 */
function normalizePerPeerValLoss(
  raw: Record<string, number | 'NaN'>,
): Record<string, number | 'NaN'> {
  const out: Record<string, number | 'NaN'> = {};
  for (const peerId of Object.keys(raw)) {
    const v = raw[peerId];
    out[peerId] = typeof v === 'number' && Number.isFinite(v) ? v : 'NaN';
  }
  return out;
}

// ── Download + verify ────────────────────────────────────────────────────────

async function downloadAndVerify(
  httpIO: DiLoCoAggregationHttpIO,
  downloadUrl: string,
  key: string,
  expectedSha256: string,
  maxBytes: number,
  sandboxRoot: string,
  destFilename: string,
): Promise<string> {
  if (!isSafePathSegment(destFilename)) {
    throw new DiLoCoValidationError(`unsafe dest filename: ${destFilename}`, 'download');
  }
  const destAbs = path.resolve(sandboxRoot, destFilename);
  const rel = path.relative(sandboxRoot, destAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DiLoCoValidationError(`dest escapes sandbox: ${destAbs}`, 'download');
  }
  // A 403/expired URL throws a typed HTTP error here → abort (P35 / P2).
  const buf = await httpIO.getUrl(downloadUrl, maxBytes);
  const sha = sha256OfBuffer(buf);
  const expected = expectedSha256.startsWith('sha256:') ? expectedSha256.slice(7) : expectedSha256;
  if (sha.toLowerCase() !== expected.toLowerCase()) {
    // P2 fail-closed — abort, never validate a tampered input.
    throw new DiLoCoValidationError(
      `sha256 mismatch for key=${key}: expected ${expected.slice(0, 12)}…, got ${sha.slice(0, 12)}…`,
      'sha256',
    );
  }
  await fs.promises.writeFile(destAbs, buf, { mode: 0o600 });
  return destAbs;
}

// ── Subprocess ────────────────────────────────────────────────────────────────

function defaultPythonBin(): string {
  return process.env.PYTHON_BIN || resolvePython();
}

function defaultRunScript(
  scriptInput: ScriptInput,
  timeoutMs: number,
  options: RunDiLoCoValidationOptions,
): Promise<ScriptOutput> {
  const bin = options.pythonBin ?? defaultPythonBin();
  const script = options.scriptPath ?? resolveValidateScript();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // P9 / F-node-008: strip wallet / keystore secrets from the child env.
      // CUDA_VISIBLE_DEVICES='' belt-and-suspenders with the script's CPU-pin.
      env: sanitizedEnvForSubprocess({
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '4',
        CUDA_VISIBLE_DEVICES: '',
      }),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.stdin?.write(JSON.stringify(scriptInput) + '\n');
    proc.stdin?.end();

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* noop */
      }
      reject(new DiLoCoValidationError(`validation script timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new DiLoCoValidationError(err.message, 'spawn'));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const line = lastJsonLine(stdout);
      if (!line) {
        reject(
          new DiLoCoValidationError(
            `script exit=${code}, no JSON stdout. stderr: ${stderr.slice(0, 800)}`,
            'script',
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(line) as ScriptOutput);
      } catch (err) {
        reject(
          new DiLoCoValidationError(
            `script stdout not JSON (exit=${code}): ${(err as Error).message}`,
            'script',
          ),
        );
      }
    });
  });
}

function lastJsonLine(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function resolveValidateScript(): string {
  // Mirrors `diloco_aggregation_runner.ts:resolveAggregateScript`. tsup
  // copies scripts/ → dist/scripts/; __filename injected per CJS chunk.
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
    path.resolve(moduleDir, '..', 'scripts', 'diloco_validate.py'),
    path.resolve(moduleDir, '..', '..', 'scripts', 'diloco_validate.py'),
    path.resolve(moduleDir, '..', '..', '..', 'scripts', 'diloco_validate.py'),
    path.resolve(process.cwd(), 'scripts', 'diloco_validate.py'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

// ── Body content signature + signed POST ──────────────────────────────────────

interface ResultBody {
  roundId: string;
  validatorPeerId: string;
  perPeerValLoss: Record<string, number | 'NaN'>;
  signature: string;
}

/**
 * Body content signature = Ed25519 over `canonicalJSON({perPeerValLoss,
 * roundId})` (recursive key-sort). REUSES the node's `canonicalJSON` from
 * `diloco-aggregation-commitment.ts` (do NOT re-implement) so the signed
 * bytes are byte-identical to what the coord recomputes. The `"NaN"` string
 * passes straight through `JSON.stringify` as `"NaN"`.
 */
async function signResult(
  perPeerValLoss: Record<string, number | 'NaN'>,
  roundId: string,
  identity: LoadedIdentity,
): Promise<string> {
  const canonical = canonicalJSON({ perPeerValLoss, roundId });
  return new IdentityHelper().sign(canonical, identity.privateKeyHex);
}

async function postResult(
  coordinatorUrl: string,
  payload: DiLoCoValidationWorkOrderPayload,
  identity: LoadedIdentity,
  body: ResultBody,
  options: RunDiLoCoValidationOptions,
): Promise<void> {
  const apiPath = `/diloco/${payload.domain}/validation-result`;
  // The transport `X-Signature` (NodeSignatureGuard) hashes the EXACT posted
  // body. The body already carries the content `signature` field, so build the
  // auth header over the COMPLETE body INCLUDING it — otherwise the guard's
  // recomputed bodyHash diverges and it 401s (same ordering trap as the
  // aggregation reveal: content-sign first → assemble → transport-sign).
  const headers = await buildSignedHeaders(apiPath, body, identity);
  await sendPost(coordinatorUrl, apiPath, headers, body, options, 'validation-result');
}

async function buildSignedHeaders(
  apiPath: string,
  body: unknown,
  identity: LoadedIdentity,
): Promise<Record<string, string>> {
  const auth = await buildAuthHeaders({
    method: 'POST',
    path: apiPath,
    body,
    privateKey: Buffer.from(identity.privateKeyHex, 'hex'),
    publicKey: Buffer.from(identity.publicKeyHex, 'hex'),
    peerId: identity.peerId,
  });
  return { 'Content-Type': 'application/json', ...auth };
}

async function sendPost(
  coordinatorUrl: string,
  apiPath: string,
  headers: Record<string, string>,
  body: unknown,
  options: RunDiLoCoValidationOptions,
  stage: string,
): Promise<void> {
  const url = `${coordinatorUrl.replace(/\/$/, '')}${apiPath}`;
  const poster =
    options.httpPost ??
    (async (u, h, b) => {
      const res = await fetch(u, { method: 'POST', headers: h, body: JSON.stringify(b) });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    });
  const res = await poster(url, headers, body);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DiLoCoValidationError(
      `${stage} POST ${apiPath} failed: HTTP ${res.status} ${text.slice(0, 400)}`,
      stage,
    );
  }
}

// ── Identity ──────────────────────────────────────────────────────────────────

function loadIdentity(): LoadedIdentity {
  const id = new IdentityHelper().loadIdentity();
  return { privateKeyHex: id.privateKey, publicKeyHex: id.publicKey, peerId: id.peerId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSafePathSegment(seg: string): boolean {
  if (!seg || seg.length === 0 || seg.length > 200) return false;
  if (seg.includes('/') || seg.includes('\\') || seg.includes('\0')) return false;
  if (seg === '.' || seg === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(seg);
}

function isHex64(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const v = s.startsWith('sha256:') ? s.slice(7) : s;
  return /^[0-9a-f]{64}$/i.test(v);
}

function isHttpUrl(s: unknown): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Test seam ──────────────────────────────────────────────────────────────────

export const __internal = {
  validatePayload,
  downloadAndVerify,
  normalizePerPeerValLoss,
  resolveValidateScript,
  isSafePathSegment,
  isHex64,
  isHttpUrl,
  lastJsonLine,
  signResult,
};
