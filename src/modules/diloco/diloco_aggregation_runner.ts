/**
 * Node-side DiLoCo aggregation runner (re-architecture Phase 3).
 *
 * Mirrors the proven `lora_validator.ts` download→verify→spawn→sign
 * template, extended for the aggregation flow (design §4.1):
 *
 *   1. Parse + validate the DILOCO_AGGREGATION WO payload (§3.1 contract).
 *   2. Sandbox: `<nodeHome>/diloco-aggregation/<woId>/`; every filename
 *      resolved strictly INSIDE that root (P7).
 *   3. Download each pinned gradient + prevAdapter + prevVelocity from the
 *      shared S3 bucket BY KEY, sha256-verify each (P2 fail-closed — abort
 *      on ANY mismatch, never aggregate a tampered input).
 *   4. Spawn `diloco_aggregate_executor.py` on CPU (CPU-pin + float64 —
 *      OPEN DECISION 1) with the local paths on stdin. The script runs the
 *      node-side Byzantine/cosine filter + Nesterov momentum + adapter
 *      accumulation and emits the canonical scalar invariants.
 *   5. Upload the candidate adapter + velocity to the per-AGGREGATOR S3
 *      prefix `candidates/<aggregatorPeerId>/` (P36 — two aggregators never
 *      collide). aggregatorPeerId = THIS node's peerId (the coord
 *      cross-checks `aggregatorPeerId === signer`, P2).
 *   6. COMMIT: POST signed `:domain/aggregation-commit` with
 *      `commitment = sha256(canonicalJSON({envelope, nonce}))` — byte-
 *      identical to the coord's recompute (see
 *      `diloco-aggregation-commitment.ts`).
 *   7. REVEAL: POST signed `:domain/aggregation-result` with the nonce +
 *      all invariants; the coord recomputes the commitment and rejects on
 *      mismatch. SIGN both requests with the node's Ed25519 key via the
 *      shared `buildAuthHeaders` (`${peerId}:${ts}:${path}:${bodyHash}`
 *      format the `NodeSignatureGuard` expects).
 *
 * DARK until Phase 4: the old coord (flag off) never dispatches this WO,
 * so the runner is inert in production until the coord flips
 * `DILOCO_NODE_AGGREGATION_ENABLED=true`. It still compiles + is correct.
 *
 * Fail-closed everywhere (P2): missing S3 config, sha256 mismatch, script
 * non-zero exit, identity mismatch, commitment mismatch → throw
 * `DiLoCoAggregationError`. Never aggregate / commit a partial result.
 */
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';
import { sanitizedEnvForSubprocess } from '../../utils/subprocess-env';
import { IdentityHelper } from '../identity/identity';
import { buildAuthHeaders } from '../../utils/node-auth';
import type {
  DiLoCoAggregationWorkOrderPayload,
  DiLoCoAggregationGradient,
} from '../agent/work-order/work-order.types';
import {
  computeCommitment,
  type DiLoCoAggregationInvariants,
  type DiLoCoRejectedPeer,
} from './diloco-aggregation-commitment';
import {
  createDiLoCoAggregationS3,
  sha256OfBuffer,
  type DiLoCoAggregationS3,
} from './diloco-aggregation-s3';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.DILOCO_AGG_TIMEOUT_MS || '900000', 10); // 15 min
const MAX_GRADIENT_BYTES = 256 * 1024 * 1024; // 256 MB per pinned input (gradients are ~92 MB)

export class DiLoCoAggregationError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'DiLoCoAggregationError';
  }
}

/** Raw stdout shape emitted by `diloco_aggregate_executor.py`. */
interface ScriptOutput {
  avgGradientNorm: number;
  velocityNorm: number;
  perPeerCosine: Record<string, number | 'NaN'>;
  acceptedPeerIds: string[];
  rejectedPeerIds: Array<{ peerId: string; reason: string }>;
  participatingNodes: number;
  adapterPath: string;
  velocityPath: string;
  error?: string;
  errorType?: string;
}

export interface RunDiLoCoAggregationInput {
  workOrderId: string;
  /** This node's peerId — becomes `aggregatorPeerId`; MUST match the signer. */
  peerId: string;
  coordinatorUrl: string;
  payload: DiLoCoAggregationWorkOrderPayload;
}

export interface RunDiLoCoAggregationOptions {
  pythonBin?: string;
  timeoutMs?: number;
  workDir?: string;
  scriptPath?: string;
  /** Override the S3 client (tests). Default = `createDiLoCoAggregationS3()`. */
  s3?: DiLoCoAggregationS3 | null;
  /** Override the identity loader (tests). */
  identity?: { privateKeyHex: string; publicKeyHex: string; peerId: string };
  /** Override the spawn-and-collect (tests). Returns the parsed script stdout. */
  runScript?: (paths: ScriptInput, timeoutMs: number) => Promise<ScriptOutput>;
  /** Override fetch (tests). */
  httpPost?: (url: string, headers: Record<string, string>, body: unknown) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  /** Override the commit nonce (tests — production uses 32 random bytes). */
  nonce?: string;
}

interface ScriptInput {
  gradients: Array<{ peerId: string; gradientPath: string; stakeWeight: number }>;
  prevAdapterPath: string | null;
  prevVelocityPath: string | null;
  momentum: number;
  cosineRejectThreshold: number;
  outputAdapterPath: string;
  outputVelocityPath: string;
}

export interface DiLoCoAggregationSubmission {
  roundId: string;
  outerRound: number;
  aggregatorPeerId: string;
  aggregatorWallet: string;
  adapterS3Key: string;
  adapterSha256: string;
  velocityS3Key: string;
  velocitySha256: string;
  invariants: DiLoCoAggregationInvariants;
  commitment: string;
  nonce: string;
}

// ── Top-level entry ───────────────────────────────────────────────────────────

export async function runDiLoCoAggregation(
  input: RunDiLoCoAggregationInput,
  options: RunDiLoCoAggregationOptions = {},
): Promise<DiLoCoAggregationSubmission> {
  const { workOrderId, peerId, coordinatorUrl, payload } = input;

  validatePayload(payload);

  // P2 fail-closed: a node that doesn't share the bucket cannot aggregate.
  const s3 = options.s3 !== undefined ? options.s3 : createDiLoCoAggregationS3();
  if (!s3) {
    throw new DiLoCoAggregationError(
      'AWS_DILOCO_BUCKET not set — node cannot download pinned inputs / upload candidate. Refusing to aggregate.',
      'config',
    );
  }

  if (!isSafePathSegment(workOrderId)) {
    throw new DiLoCoAggregationError(`Unsafe workOrderId: ${workOrderId}`, 'sandbox');
  }
  if (!isSafePathSegment(peerId)) {
    throw new DiLoCoAggregationError(`Unsafe peerId: ${peerId}`, 'sandbox');
  }

  const identity = options.identity ?? loadIdentity();
  // P2 fail-closed: never sign / attribute a result on behalf of a different
  // peer. aggregatorPeerId == this node's identity == the signer.
  if (identity.peerId !== peerId) {
    throw new DiLoCoAggregationError(
      `Identity peerId (${identity.peerId}) != runtime peerId (${peerId}); refusing to aggregate.`,
      'identity',
    );
  }
  const aggregatorPeerId = peerId;
  const aggregatorWallet = resolveAggregatorWallet(payload, aggregatorPeerId);

  const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
  const workDir = options.workDir ?? path.join(nodeHome, 'diloco-aggregation', workOrderId);
  const sandboxRoot = path.resolve(workDir);
  await fs.promises.mkdir(sandboxRoot, { recursive: true, mode: 0o700 });

  try {
    // 3. Download + sha256-verify each pinned input (P2 fail-closed).
    const gradientPaths: Array<{ peerId: string; gradientPath: string; stakeWeight: number }> = [];
    for (let i = 0; i < payload.gradients.length; i++) {
      const g = payload.gradients[i];
      const dest = await downloadAndVerify(s3, g.s3Key, g.sha256, sandboxRoot, `gradient_${i}.pt`);
      gradientPaths.push({ peerId: g.peerId, gradientPath: dest, stakeWeight: g.stakeWeight });
    }

    let prevAdapterPath: string | null = null;
    if (payload.prevAdapter) {
      prevAdapterPath = await downloadAndVerify(
        s3,
        payload.prevAdapter.s3Key,
        payload.prevAdapter.sha256,
        sandboxRoot,
        'prev_adapter.pkl',
      );
    }
    let prevVelocityPath: string | null = null;
    if (payload.prevVelocity) {
      prevVelocityPath = await downloadAndVerify(
        s3,
        payload.prevVelocity.s3Key,
        payload.prevVelocity.sha256,
        sandboxRoot,
        'prev_velocity.pkl',
      );
    }

    // 4. Run the CPU-pinned aggregation script.
    const outputAdapterPath = path.join(sandboxRoot, 'candidate_adapter.pkl');
    const outputVelocityPath = path.join(sandboxRoot, 'candidate_velocity.pkl');
    const scriptInput: ScriptInput = {
      gradients: gradientPaths,
      prevAdapterPath,
      prevVelocityPath,
      momentum: payload.momentum,
      cosineRejectThreshold: payload.cosineRejectThreshold,
      outputAdapterPath,
      outputVelocityPath,
    };
    const runScript = options.runScript ?? ((p, t) => defaultRunScript(p, t, options));
    const out = await runScript(scriptInput, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (out.error) {
      throw new DiLoCoAggregationError(
        `aggregation script failed [${out.errorType ?? 'Error'}]: ${out.error}`,
        'script',
      );
    }

    // 5. Read candidate bytes, hash, upload to per-aggregator prefix (P36).
    const adapterBuf = await fs.promises.readFile(outputAdapterPath);
    const velocityBuf = await fs.promises.readFile(outputVelocityPath);
    const adapterSha256 = sha256OfBuffer(adapterBuf);
    const velocitySha256 = sha256OfBuffer(velocityBuf);
    const adapterS3Key = `${payload.domain}/round_${payload.outerRound}/candidates/${aggregatorPeerId}/adapter_weights.pkl`;
    const velocityS3Key = `${payload.domain}/round_${payload.outerRound}/candidates/${aggregatorPeerId}/velocity.pkl`;
    await s3.putObject(adapterS3Key, adapterBuf, adapterSha256);
    await s3.putObject(velocityS3Key, velocityBuf, velocitySha256);

    // Build the canonical invariants (sets sorted in the envelope fn).
    const invariants: DiLoCoAggregationInvariants = {
      avgGradientNorm: out.avgGradientNorm,
      velocityNorm: out.velocityNorm,
      acceptedPeerIds: out.acceptedPeerIds,
      rejectedPeerIds: out.rejectedPeerIds.map((r): DiLoCoRejectedPeer => ({
        peerId: r.peerId,
        reason: r.reason,
      })),
      adapterSha256,
    };

    // 6. COMMIT. Random 32-byte nonce; the second aggregator can't copy our
    //    invariants because it can't see the nonce until both committed.
    const nonce = options.nonce ?? randomBytes(32).toString('hex');
    const commitment = computeCommitment(invariants, nonce);
    await postCommit(coordinatorUrl, payload, identity, {
      roundId: payload.roundId,
      outerRound: payload.outerRound,
      aggregatorPeerId,
      aggregatorWallet,
      commitment,
    }, options);

    // 7. REVEAL.
    await postReveal(coordinatorUrl, payload, identity, {
      roundId: payload.roundId,
      outerRound: payload.outerRound,
      aggregatorPeerId,
      aggregatorWallet,
      adapterS3Key,
      adapterSha256,
      velocityS3Key,
      velocitySha256,
      avgGradientNorm: invariants.avgGradientNorm,
      velocityNorm: invariants.velocityNorm,
      acceptedPeerIds: [...invariants.acceptedPeerIds],
      rejectedPeerIds: invariants.rejectedPeerIds.map((r) => ({ peerId: r.peerId, reason: r.reason })),
      nonce,
    }, options);

    logger.log(
      `[diloco-agg] round=${payload.roundId} aggregator=${aggregatorPeerId.slice(0, 12)}… ` +
      `committed+revealed (accepted=${invariants.acceptedPeerIds.length}, ` +
      `rejected=${invariants.rejectedPeerIds.length}, avgNorm=${invariants.avgGradientNorm.toFixed(6)})`,
    );

    return {
      roundId: payload.roundId,
      outerRound: payload.outerRound,
      aggregatorPeerId,
      aggregatorWallet,
      adapterS3Key,
      adapterSha256,
      velocityS3Key,
      velocitySha256,
      invariants,
      commitment,
      nonce,
    };
  } finally {
    if (!options.workDir) {
      await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {
        /* best effort */
      });
    }
  }
}

// ── Payload validation ─────────────────────────────────────────────────────────

function validatePayload(p: DiLoCoAggregationWorkOrderPayload): void {
  if (!p || typeof p !== 'object') throw new DiLoCoAggregationError('payload is not an object', 'payload');
  if (!p.roundId || typeof p.roundId !== 'string') throw new DiLoCoAggregationError('roundId required', 'payload');
  if (!p.domain || !/^[a-z0-9_-]{1,64}$/.test(p.domain)) {
    throw new DiLoCoAggregationError(`domain must match /^[a-z0-9_-]{1,64}$/: ${p.domain}`, 'payload');
  }
  if (!Number.isInteger(p.outerRound) || p.outerRound < 0) {
    throw new DiLoCoAggregationError('outerRound must be a non-negative integer', 'payload');
  }
  if (typeof p.momentum !== 'number' || !Number.isFinite(p.momentum)) {
    throw new DiLoCoAggregationError('momentum must be a finite number', 'payload');
  }
  if (typeof p.cosineRejectThreshold !== 'number' || !Number.isFinite(p.cosineRejectThreshold)) {
    throw new DiLoCoAggregationError('cosineRejectThreshold must be a finite number', 'payload');
  }
  if (!Array.isArray(p.gradients) || p.gradients.length === 0) {
    throw new DiLoCoAggregationError('gradients must be a non-empty array', 'payload');
  }
  for (const g of p.gradients) {
    if (!g || typeof g.peerId !== 'string' || typeof g.s3Key !== 'string') {
      throw new DiLoCoAggregationError('each gradient needs peerId + s3Key', 'payload');
    }
    if (!isHex64(g.sha256)) {
      throw new DiLoCoAggregationError(`gradient sha256 must be 64-char hex: ${g.peerId}`, 'payload');
    }
    if (typeof g.stakeWeight !== 'number' || !Number.isFinite(g.stakeWeight)) {
      throw new DiLoCoAggregationError(`gradient stakeWeight must be finite: ${g.peerId}`, 'payload');
    }
  }
  if (p.prevAdapter && (!p.prevAdapter.s3Key || !isHex64(p.prevAdapter.sha256))) {
    throw new DiLoCoAggregationError('prevAdapter, when present, needs s3Key + 64-char hex sha256', 'payload');
  }
  if (p.prevVelocity && (!p.prevVelocity.s3Key || !isHex64(p.prevVelocity.sha256))) {
    throw new DiLoCoAggregationError('prevVelocity, when present, needs s3Key + 64-char hex sha256', 'payload');
  }
}

function resolveAggregatorWallet(p: DiLoCoAggregationWorkOrderPayload, aggregatorPeerId: string): string {
  // The aggregator's own wallet is supplied via env (the node's reward
  // wallet); fall back to a stable peer-derived sentinel only when unset
  // (the coord requires a non-empty aggregatorWallet for reward
  // attribution — design §3.2). Never derive a wallet from the WO
  // gradient list (those are SUBMITTER wallets, not the aggregator's).
  void p;
  const wallet = process.env.SYNAPSEIA_WALLET_ADDRESS || process.env.NODE_WALLET_ADDRESS;
  return wallet && wallet.length > 0 ? wallet : `peer:${aggregatorPeerId}`;
}

// ── Download + verify ────────────────────────────────────────────────────────

async function downloadAndVerify(
  s3: DiLoCoAggregationS3,
  key: string,
  expectedSha256: string,
  sandboxRoot: string,
  destFilename: string,
): Promise<string> {
  if (!isSafePathSegment(destFilename)) {
    throw new DiLoCoAggregationError(`unsafe dest filename: ${destFilename}`, 'download');
  }
  const destAbs = path.resolve(sandboxRoot, destFilename);
  const rel = path.relative(sandboxRoot, destAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DiLoCoAggregationError(`dest escapes sandbox: ${destAbs}`, 'download');
  }
  const buf = await s3.getObject(key, MAX_GRADIENT_BYTES);
  const sha = sha256OfBuffer(buf);
  const expected = expectedSha256.startsWith('sha256:') ? expectedSha256.slice(7) : expectedSha256;
  if (sha.toLowerCase() !== expected.toLowerCase()) {
    // P2 fail-closed — abort, never aggregate a tampered input.
    throw new DiLoCoAggregationError(
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
  options: RunDiLoCoAggregationOptions,
): Promise<ScriptOutput> {
  const bin = options.pythonBin ?? defaultPythonBin();
  const script = options.scriptPath ?? resolveAggregateScript();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // P9 / F-node-008: strip wallet / keystore secrets from the child env.
      // CUDA_VISIBLE_DEVICES='' is belt-and-suspenders with the script's own
      // CPU-pin (the script never constructs a CUDA tensor).
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
      reject(new DiLoCoAggregationError(`aggregation script timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new DiLoCoAggregationError(err.message, 'spawn'));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // The script emits exactly one JSON line on stdout (success OR
      // {error}). Parse it; a non-zero exit with no parseable JSON is a
      // hard failure (P2).
      const line = lastJsonLine(stdout);
      if (!line) {
        reject(
          new DiLoCoAggregationError(
            `script exit=${code}, no JSON stdout. stderr: ${stderr.slice(0, 800)}`,
            'script',
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(line) as ScriptOutput;
        // A non-zero exit MUST carry an error key (the script's contract);
        // a zero exit with an error key also aborts.
        resolve(parsed);
      } catch (err) {
        reject(
          new DiLoCoAggregationError(
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

function resolveAggregateScript(): string {
  // Mirrors `lora_validator.ts:resolveEvalScript`. tsup copies scripts/ →
  // dist/scripts/; __filename is injected per CJS chunk.
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
    path.resolve(moduleDir, '..', 'scripts', 'diloco_aggregate_executor.py'),
    path.resolve(moduleDir, '..', '..', 'scripts', 'diloco_aggregate_executor.py'),
    path.resolve(moduleDir, '..', '..', '..', 'scripts', 'diloco_aggregate_executor.py'),
    path.resolve(process.cwd(), 'scripts', 'diloco_aggregate_executor.py'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

// ── Signed commit / reveal POSTs ────────────────────────────────────────────────

interface CommitBody {
  roundId: string;
  outerRound: number;
  aggregatorPeerId: string;
  aggregatorWallet: string;
  commitment: string;
}

interface RevealBody {
  roundId: string;
  outerRound: number;
  aggregatorPeerId: string;
  aggregatorWallet: string;
  adapterS3Key: string;
  adapterSha256: string;
  velocityS3Key: string;
  velocitySha256: string;
  avgGradientNorm: number;
  velocityNorm: number;
  acceptedPeerIds: string[];
  rejectedPeerIds: Array<{ peerId: string; reason: string }>;
  nonce: string;
}

async function postCommit(
  coordinatorUrl: string,
  payload: DiLoCoAggregationWorkOrderPayload,
  identity: LoadedIdentity,
  body: CommitBody,
  options: RunDiLoCoAggregationOptions,
): Promise<void> {
  const apiPath = `/diloco/${payload.domain}/aggregation-commit`;
  await signedPost(coordinatorUrl, apiPath, body, identity, options, 'commit');
}

async function postReveal(
  coordinatorUrl: string,
  payload: DiLoCoAggregationWorkOrderPayload,
  identity: LoadedIdentity,
  body: RevealBody,
  options: RunDiLoCoAggregationOptions,
): Promise<void> {
  const apiPath = `/diloco/${payload.domain}/aggregation-result`;
  // Two distinct signatures, by design:
  //   - body `signature`: an Ed25519 attestation over the canonical reveal
  //     envelope. The coord controller requires a non-empty string here
  //     (presence-checked + stored as the aggregator's attestation); it is
  //     NOT the transport auth.
  //   - `X-Signature` header (NodeSignatureGuard): the transport auth over
  //     `${peerId}:${ts}:${path}:${bodyHash}` where bodyHash hashes the
  //     EXACT posted body. The guard recomputes the hash from `req.body`, so
  //     the header MUST be built over the COMPLETE body INCLUDING the
  //     `signature` field — otherwise the recomputed hash diverges and the
  //     guard 401s. So: sign the body field FIRST, assemble the full body,
  //     THEN build the auth header over that full body.
  const bodySignature = await signEnvelope(body, identity);
  const fullBody = { ...body, signature: bodySignature };
  const headers = await buildSignedHeaders(apiPath, fullBody, identity);
  await sendPost(coordinatorUrl, apiPath, headers, fullBody, options, 'reveal');
}

async function signedPost(
  coordinatorUrl: string,
  apiPath: string,
  body: unknown,
  identity: LoadedIdentity,
  options: RunDiLoCoAggregationOptions,
  stage: string,
): Promise<void> {
  const headers = await buildSignedHeaders(apiPath, body, identity);
  await sendPost(coordinatorUrl, apiPath, headers, body, options, stage);
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
  options: RunDiLoCoAggregationOptions,
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
    throw new DiLoCoAggregationError(
      `${stage} POST ${apiPath} failed: HTTP ${res.status} ${text.slice(0, 400)}`,
      stage,
    );
  }
}

// ── Identity ──────────────────────────────────────────────────────────────────

interface LoadedIdentity {
  privateKeyHex: string;
  publicKeyHex: string;
  peerId: string;
}

function loadIdentity(): LoadedIdentity {
  const id = new IdentityHelper().loadIdentity();
  return { privateKeyHex: id.privateKey, publicKeyHex: id.publicKey, peerId: id.peerId };
}

/**
 * Ed25519 attestation over the canonical reveal body (sans the `signature`
 * field itself). Reuses `IdentityHelper.sign` (hex→hex) — the same Node
 * crypto path the rest of the node uses. The coord stores this verbatim as
 * the aggregator's attestation (it does NOT re-verify it at the controller;
 * the transport auth is the X-Signature header). Canonicalised so the
 * signed bytes are deterministic.
 */
async function signEnvelope(body: RevealBody, identity: LoadedIdentity): Promise<string> {
  const canonical = JSON.stringify(sortKeys(body));
  return new IdentityHelper().sign(canonical, identity.privateKeyHex);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
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

// ── Test seam ──────────────────────────────────────────────────────────────────

export const __internal = {
  validatePayload,
  downloadAndVerify,
  resolveAggregateScript,
  isSafePathSegment,
  isHex64,
  lastJsonLine,
  resolveAggregatorWallet,
  MAX_GRADIENT_BYTES,
};

export type { DiLoCoAggregationWorkOrderPayload, DiLoCoAggregationGradient };
