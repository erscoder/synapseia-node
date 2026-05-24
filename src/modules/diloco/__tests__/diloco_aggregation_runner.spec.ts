/**
 * DiLoCo aggregation runner tests (node-side aggregation, Phase 3).
 *
 * S3, the python script, identity and HTTP are all injected (the runner
 * exposes test seams) so these run fast + offline. The python script
 * itself is covered separately by
 * `scripts/__tests__/diloco_aggregate_executor_test.py` (real torch).
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  runDiLoCoAggregation,
  DiLoCoAggregationError,
  __internal,
  type RunDiLoCoAggregationOptions,
} from '../diloco_aggregation_runner';
import type { DiLoCoAggregationWorkOrderPayload } from '../../agent/work-order/work-order.types';
import { computeCommitment } from '../diloco-aggregation-commitment';
import type { DiLoCoAggregationS3 } from '../diloco-aggregation-s3';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// A tiny in-memory S3 double: each key maps to a fixed buffer; sha256 of
// the buffer is what we pin in the WO so the verify passes by default.
function makeS3(objects: Record<string, Buffer>): {
  s3: DiLoCoAggregationS3;
  puts: Array<{ key: string; sha256: string; len: number }>;
} {
  const puts: Array<{ key: string; sha256: string; len: number }> = [];
  const s3: DiLoCoAggregationS3 = {
    bucket: 'test-bucket',
    async getObject(key: string): Promise<Buffer> {
      const buf = objects[key];
      if (!buf) throw new Error(`no such key ${key}`);
      return buf;
    },
    async putObject(key: string, body: Buffer, sha256Hex: string): Promise<void> {
      puts.push({ key, sha256: sha256Hex, len: body.length });
    },
  };
  return { s3, puts };
}

const PEER = 'aggpeer123';
const WALLET = 'WaLLeT1111111111111111111111111111111111111';

const gradBufA = Buffer.from('gradient-A-bytes');
const gradBufB = Buffer.from('gradient-B-bytes');
const prevAdapBuf = Buffer.from('prev-adapter-bytes');
const prevVelBuf = Buffer.from('prev-velocity-bytes');

function basePayload(over: Partial<DiLoCoAggregationWorkOrderPayload> = {}): DiLoCoAggregationWorkOrderPayload {
  return {
    roundId: 'diloco_med_7_1700000000000',
    domain: 'med',
    outerRound: 7,
    modelId: 'Qwen/Qwen2.5-7B-Instruct',
    momentum: 0.9,
    gradients: [
      { peerId: 'p1', walletAddress: 'w1', s3Key: 'med/round_7/gradients/p1.pt', sha256: sha(gradBufA), stakeWeight: 0.6 },
      { peerId: 'p2', walletAddress: 'w2', s3Key: 'med/round_7/gradients/p2.pt', sha256: sha(gradBufB), stakeWeight: 0.4 },
    ],
    prevAdapter: { s3Key: 'med/latest/adapter_weights.pkl', sha256: sha(prevAdapBuf) },
    prevVelocity: { s3Key: 'med/velocity/round_6.pkl', sha256: sha(prevVelBuf) },
    cosineRejectThreshold: 0.3,
    effectiveQuorum: 2,
    deadlineMs: 1700000900000,
    ...over,
  };
}

const objectsFor = (p: DiLoCoAggregationWorkOrderPayload): Record<string, Buffer> => {
  const o: Record<string, Buffer> = {
    [p.gradients[0].s3Key]: gradBufA,
    [p.gradients[1].s3Key]: gradBufB,
  };
  if (p.prevAdapter) o[p.prevAdapter.s3Key] = prevAdapBuf;
  if (p.prevVelocity) o[p.prevVelocity.s3Key] = prevVelBuf;
  return o;
};

// A script double that writes the candidate files (the runner reads them
// back) and returns canonical invariants.
function makeRunScript(adapterBytes = 'cand-adapter', velocityBytes = 'cand-velocity'): RunDiLoCoAggregationOptions['runScript'] {
  return async (paths) => {
    await fs.promises.writeFile(paths.outputAdapterPath, Buffer.from(adapterBytes));
    await fs.promises.writeFile(paths.outputVelocityPath, Buffer.from(velocityBytes));
    return {
      avgGradientNorm: 0.045,
      velocityNorm: 0.032,
      perPeerCosine: { p1: 0.95, p2: 0.91 },
      acceptedPeerIds: ['p1', 'p2'],
      rejectedPeerIds: [],
      participatingNodes: 2,
      adapterPath: paths.outputAdapterPath,
      velocityPath: paths.outputVelocityPath,
    };
  };
}

// Real ed25519 keypair so the transport-signature parity test can verify
// the X-Signature against the matching public key (a dummy pubkey would
// fail verify even with a correct signature).
const PRIV_HEX = '11'.repeat(32);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _ed = require('@noble/ed25519');
const { sha512: _sha512 } = require('@noble/hashes/sha2.js');
(_ed.hashes as Record<string, unknown>).sha512 = _sha512;
const PUB_HEX = Buffer.from(_ed.getPublicKey(new Uint8Array(Buffer.from(PRIV_HEX, 'hex')))).toString('hex');
const identity = { privateKeyHex: PRIV_HEX, publicKeyHex: PUB_HEX, peerId: PEER };

function makeOptions(over: Partial<RunDiLoCoAggregationOptions> = {}): RunDiLoCoAggregationOptions {
  return {
    s3: makeS3({}).s3, // replaced per-test
    identity,
    runScript: makeRunScript(),
    nonce: 'ab'.repeat(32),
    httpPost: jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' })),
    workDir: undefined,
    ...over,
  };
}

describe('runDiLoCoAggregation', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlagg-test-'));
    process.env.SYNAPSEIA_WALLET_ADDRESS = WALLET;
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    delete process.env.SYNAPSEIA_WALLET_ADDRESS;
  });

  it('happy path: downloads pinned keys, runs, uploads candidate, commits + reveals', async () => {
    const payload = basePayload();
    const { s3, puts } = makeS3(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const opts = makeOptions({ s3, httpPost, workDir });

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_1', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      opts,
    );

    // candidate uploaded to the per-aggregator prefix (P36)
    expect(puts.map((p) => p.key).sort()).toEqual([
      `med/round_7/candidates/${PEER}/adapter_weights.pkl`,
      `med/round_7/candidates/${PEER}/velocity.pkl`,
    ]);
    expect(sub.aggregatorPeerId).toBe(PEER);
    expect(sub.aggregatorWallet).toBe(WALLET);
    expect(sub.adapterS3Key).toBe(`med/round_7/candidates/${PEER}/adapter_weights.pkl`);
    expect(sub.invariants.acceptedPeerIds).toEqual(['p1', 'p2']);

    // commit + reveal both posted, in order
    expect(httpPost).toHaveBeenCalledTimes(2);
    const [commitCall, revealCall] = httpPost.mock.calls;
    expect(commitCall[0]).toBe('https://coord/diloco/med/aggregation-commit');
    expect(revealCall[0]).toBe('https://coord/diloco/med/aggregation-result');
  });

  it('commit body carries commitment == sha256(canonicalEnvelope || nonce)', async () => {
    const payload = basePayload();
    const { s3 } = makeS3(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const opts = makeOptions({ s3, httpPost, workDir });

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_2', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      opts,
    );

    const commitBody = httpPost.mock.calls[0][2] as { commitment: string };
    const expected = computeCommitment(sub.invariants, sub.nonce);
    expect(commitBody.commitment).toBe(expected);
    expect(sub.commitment).toBe(expected);
  });

  it('reveal body carries the nonce + invariants and matches the commitment', async () => {
    const payload = basePayload();
    const { s3 } = makeS3(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const opts = makeOptions({ s3, httpPost, workDir });

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_3', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      opts,
    );

    const revealBody = httpPost.mock.calls[1][2] as Record<string, unknown>;
    expect(revealBody.nonce).toBe(sub.nonce);
    expect(revealBody.aggregatorPeerId).toBe(PEER);
    expect(revealBody.adapterSha256).toBe(sub.adapterSha256);
    expect(revealBody.acceptedPeerIds).toEqual(['p1', 'p2']);
    // a reveal body carries the same fields the coord recomputes the commitment from
    const recomputed = computeCommitment(
      {
        avgGradientNorm: revealBody.avgGradientNorm as number,
        velocityNorm: revealBody.velocityNorm as number,
        acceptedPeerIds: revealBody.acceptedPeerIds as string[],
        rejectedPeerIds: revealBody.rejectedPeerIds as Array<{ peerId: string; reason: string }>,
        adapterSha256: revealBody.adapterSha256 as string,
      },
      revealBody.nonce as string,
    );
    expect(recomputed).toBe(sub.commitment);
  });

  it('reveal carries a non-empty body signature AND a transport X-Signature header (both required)', async () => {
    const payload = basePayload();
    const { s3 } = makeS3(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_sig', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ s3, httpPost, workDir }),
    );
    const revealHeaders = httpPost.mock.calls[1][1] as Record<string, string>;
    const revealBody = httpPost.mock.calls[1][2] as { signature: string };
    // Body `signature` is the aggregator's attestation (controller presence
    // check) — a non-empty hex string, distinct from the transport header.
    expect(typeof revealBody.signature).toBe('string');
    expect(revealBody.signature.length).toBeGreaterThan(0);
    // Transport auth header (NodeSignatureGuard) is base64 + bound to peer.
    expect(typeof revealHeaders['X-Signature']).toBe('string');
    expect(revealHeaders['X-Peer-Id']).toBe(PEER);
    // The two signatures are NOT the same value (body=hex attestation,
    // header=base64 transport auth over the FULL posted body).
    expect(revealBody.signature).not.toBe(revealHeaders['X-Signature']);
  });

  it('reveal X-Signature is computed over the FULL posted body (NodeSignatureGuard parity)', async () => {
    // Regression: the transport auth hashes req.body; if the header were
    // signed over a body WITHOUT the `signature` field but the POST sent the
    // body WITH it, the guard's recomputed bodyHash would diverge → 401.
    // Here we replicate the guard's verification to prove parity.
    const ed = await import('@noble/ed25519');
    const { sha256, sha512 } = await import('@noble/hashes/sha2.js');
    (ed.hashes as Record<string, unknown>).sha512 = sha512;

    const payload = basePayload();
    const { s3 } = makeS3(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await runDiLoCoAggregation(
      { workOrderId: 'wo_sig_parity', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ s3, httpPost, workDir }),
    );
    const headers = httpPost.mock.calls[1][1] as Record<string, string>;
    const body = httpPost.mock.calls[1][2];

    // Replicate node-auth bodyHash over the EXACT posted body (sorted keys).
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : v && typeof v === 'object'
          ? Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((a, k) => {
              a[k] = sortKeys((v as Record<string, unknown>)[k]);
              return a;
            }, {})
          : v;
    const bodyStr = JSON.stringify(sortKeys(body));
    const bodyHash = Buffer.from(sha256(new TextEncoder().encode(bodyStr))).toString('base64');
    const message = `${PEER}:${headers['X-Timestamp']}:/diloco/med/aggregation-result:${bodyHash}`;
    const ok = ed.verify(
      new Uint8Array(Buffer.from(headers['X-Signature'], 'base64')),
      new TextEncoder().encode(message),
      new Uint8Array(Buffer.from(identity.publicKeyHex, 'hex')),
    );
    expect(ok).toBe(true);
  });

  // ── sha256 fail-closed for EACH pinned input (P2) ───────────────────────────

  it('fails closed on gradient sha256 mismatch — no script, no upload, no commit', async () => {
    const payload = basePayload();
    payload.gradients[1].sha256 = 'f'.repeat(64); // wrong
    const { s3, puts } = makeS3(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));

    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_g', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ s3, runScript, httpPost, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('fails closed on prevAdapter sha256 mismatch', async () => {
    const payload = basePayload();
    payload.prevAdapter = { s3Key: payload.prevAdapter!.s3Key, sha256: 'e'.repeat(64) };
    const { s3, puts } = makeS3(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_pa', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ s3, runScript, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('fails closed on prevVelocity sha256 mismatch', async () => {
    const payload = basePayload();
    payload.prevVelocity = { s3Key: payload.prevVelocity!.s3Key, sha256: 'd'.repeat(64) };
    const { s3, puts } = makeS3(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_pv', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ s3, runScript, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  // ── round-0 null handling (§2 cold start) ────────────────────────────────────

  it('round 0: null prevAdapter + null prevVelocity handled (no download of either)', async () => {
    const payload = basePayload({ outerRound: 0, prevAdapter: null, prevVelocity: null });
    const objects = {
      [payload.gradients[0].s3Key]: gradBufA,
      [payload.gradients[1].s3Key]: gradBufB,
    };
    const getObject = jest.fn(async (key: string) => {
      const b = objects[key];
      if (!b) throw new Error(`no key ${key}`);
      return b;
    });
    const s3: DiLoCoAggregationS3 = { bucket: 'b', getObject, putObject: jest.fn() };
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_r0', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ s3, httpPost, workDir }),
    );
    // only the two gradient keys were downloaded (no prevAdapter/prevVelocity)
    expect(getObject).toHaveBeenCalledTimes(2);
    expect(sub.adapterS3Key).toBe(`med/round_0/candidates/${PEER}/adapter_weights.pkl`);
    expect(httpPost).toHaveBeenCalledTimes(2);
  });

  // ── identity / signer cross-check (P2) ───────────────────────────────────────

  it('fails closed when identity peerId != runtime peerId (never sign for another peer)', async () => {
    const payload = basePayload();
    const { s3 } = makeS3(objectsFor(payload));
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_id', peerId: 'OTHERPEER', coordinatorUrl: 'https://coord', payload },
        makeOptions({ s3, workDir }),
      ),
    ).rejects.toThrow(/Identity peerId .* != runtime peerId/);
  });

  // ── config fail-closed ───────────────────────────────────────────────────────

  it('fails closed when S3 is not configured (no shared bucket)', async () => {
    const payload = basePayload();
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_noS3', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ s3: null, workDir }),
      ),
    ).rejects.toThrow(/AWS_DILOCO_BUCKET not set/);
  });

  // ── script error surfaces as abort ───────────────────────────────────────────

  it('aborts when the script returns an error key (no commit/reveal)', async () => {
    const payload = basePayload();
    const { s3, puts } = makeS3(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const runScript: RunDiLoCoAggregationOptions['runScript'] = async () => ({
      avgGradientNorm: 0,
      velocityNorm: 0,
      perPeerCosine: {},
      acceptedPeerIds: [],
      rejectedPeerIds: [],
      participatingNodes: 0,
      adapterPath: '',
      velocityPath: '',
      error: 'no usable gradients after filter',
      errorType: 'ValueError',
    });
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_err', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ s3, httpPost, runScript, workDir }),
      ),
    ).rejects.toThrow(/aggregation script failed/);
    expect(puts).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
  });
});

describe('runner internals', () => {
  it('validatePayload rejects empty gradients', () => {
    expect(() => __internal.validatePayload(basePayload({ gradients: [] }))).toThrow(/non-empty/);
  });
  it('validatePayload rejects bad domain', () => {
    expect(() => __internal.validatePayload(basePayload({ domain: '../etc' }))).toThrow(/domain must match/);
  });
  it('validatePayload rejects non-hex gradient sha', () => {
    const p = basePayload();
    p.gradients[0].sha256 = 'nothex';
    expect(() => __internal.validatePayload(p)).toThrow(/64-char hex/);
  });
  it('isHex64 accepts sha256: prefix', () => {
    expect(__internal.isHex64('sha256:' + 'a'.repeat(64))).toBe(true);
    expect(__internal.isHex64('a'.repeat(64))).toBe(true);
    expect(__internal.isHex64('a'.repeat(63))).toBe(false);
  });
  it('lastJsonLine extracts the final JSON object line', () => {
    expect(__internal.lastJsonLine('log noise\n{"a":1}\nmore noise\n{"b":2}\n')).toBe('{"b":2}');
    expect(__internal.lastJsonLine('no json here')).toBeNull();
  });
  it('isSafePathSegment rejects traversal', () => {
    expect(__internal.isSafePathSegment('wo_1')).toBe(true);
    expect(__internal.isSafePathSegment('../x')).toBe(false);
    expect(__internal.isSafePathSegment('a/b')).toBe(false);
  });
});
