/**
 * DiLoCo aggregation runner tests (node-side aggregation, Phase 4 —
 * coord-mediated presigned-URL S3 I/O).
 *
 * The presigned-URL HTTP I/O, the python script, identity and the signed
 * POSTs are all injected (the runner exposes test seams) so these run fast +
 * offline. The node holds NO AWS creds: every input is fetched via the
 * coord-presigned `downloadUrl` and the candidate is PUT via
 * `adapterUploadUrl`/`velocityUploadUrl`. The python script itself is covered
 * separately by `scripts/__tests__/diloco_aggregate_executor_test.py`.
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
import type { DiLoCoAggregationHttpIO } from '../diloco-aggregation-http';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const PEER = 'aggpeer123';
const WALLET = 'WaLLeT1111111111111111111111111111111111111';

const gradBufA = Buffer.from('gradient-A-bytes');
const gradBufB = Buffer.from('gradient-B-bytes');
const prevAdapBuf = Buffer.from('prev-adapter-bytes');
const prevVelBuf = Buffer.from('prev-velocity-bytes');

// Presigned URLs — opaque https URLs keyed to each input so the HTTP double
// can map url → bytes (the runner only ever sees `downloadUrl`, not the key).
const URL_GRAD_A = 'https://s3.example.com/med/round_7/gradients/p1.pt?sig=A';
const URL_GRAD_B = 'https://s3.example.com/med/round_7/gradients/p2.pt?sig=B';
const URL_PREV_ADAPTER = 'https://s3.example.com/med/latest/adapter_weights.pkl?sig=PA';
const URL_PREV_VELOCITY = 'https://s3.example.com/med/velocity/round_6.pkl?sig=PV';
const URL_PUT_ADAPTER = `https://s3.example.com/med/round_7/candidates/${PEER}/adapter_weights.pkl?sig=UA`;
const URL_PUT_VELOCITY = `https://s3.example.com/med/round_7/candidates/${PEER}/velocity.pkl?sig=UV`;

// A tiny in-memory presigned-URL HTTP double: GET maps url → buffer; PUT
// records the upload (url + sha256 of the body + length).
function makeHttpIO(objects: Record<string, Buffer>): {
  httpIO: DiLoCoAggregationHttpIO;
  puts: Array<{ url: string; sha256: string; len: number }>;
} {
  const puts: Array<{ url: string; sha256: string; len: number }> = [];
  const httpIO: DiLoCoAggregationHttpIO = {
    async getUrl(url: string): Promise<Buffer> {
      const buf = objects[url];
      if (!buf) throw new DiLoCoAggregationError(`no such url ${url}`, 'download');
      return buf;
    },
    async putUrl(url: string, body: Buffer): Promise<void> {
      puts.push({ url, sha256: sha(body), len: body.length });
    },
  };
  return { httpIO, puts };
}

function basePayload(over: Partial<DiLoCoAggregationWorkOrderPayload> = {}): DiLoCoAggregationWorkOrderPayload {
  return {
    roundId: 'diloco_med_7_1700000000000',
    domain: 'med',
    outerRound: 7,
    modelId: 'Qwen/Qwen2.5-7B-Instruct',
    momentum: 0.9,
    gradients: [
      { peerId: 'p1', walletAddress: 'w1', s3Key: 'med/round_7/gradients/p1.pt', sha256: sha(gradBufA), stakeWeight: 0.6, downloadUrl: URL_GRAD_A },
      { peerId: 'p2', walletAddress: 'w2', s3Key: 'med/round_7/gradients/p2.pt', sha256: sha(gradBufB), stakeWeight: 0.4, downloadUrl: URL_GRAD_B },
    ],
    prevAdapter: { s3Key: 'med/latest/adapter_weights.pkl', sha256: sha(prevAdapBuf), downloadUrl: URL_PREV_ADAPTER },
    prevVelocity: { s3Key: 'med/velocity/round_6.pkl', sha256: sha(prevVelBuf), downloadUrl: URL_PREV_VELOCITY },
    adapterUploadUrl: URL_PUT_ADAPTER,
    velocityUploadUrl: URL_PUT_VELOCITY,
    cosineRejectThreshold: 0.3,
    effectiveQuorum: 2,
    deadlineMs: 1700000900000,
    ...over,
  };
}

const objectsFor = (p: DiLoCoAggregationWorkOrderPayload): Record<string, Buffer> => {
  const o: Record<string, Buffer> = {
    [p.gradients[0].downloadUrl]: gradBufA,
    [p.gradients[1].downloadUrl]: gradBufB,
  };
  if (p.prevAdapter) o[p.prevAdapter.downloadUrl] = prevAdapBuf;
  if (p.prevVelocity) o[p.prevVelocity.downloadUrl] = prevVelBuf;
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
    httpIO: makeHttpIO({}).httpIO, // replaced per-test
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

  it('happy path: downloads via presigned URLs, runs, uploads candidate via PUT URLs, commits + reveals', async () => {
    const payload = basePayload();
    const { httpIO, puts } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const opts = makeOptions({ httpIO, httpPost, workDir });

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_1', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      opts,
    );

    // candidate uploaded via the per-aggregator presigned PUT URLs (P36)
    expect(puts.map((p) => p.url).sort()).toEqual([URL_PUT_ADAPTER, URL_PUT_VELOCITY].sort());
    expect(sub.aggregatorPeerId).toBe(PEER);
    expect(sub.aggregatorWallet).toBe(WALLET);
    // reported s3Key = the candidate key behind the presigned PUT URL so the
    // coord (which has direct S3) can read it back + verify sha256.
    expect(sub.adapterS3Key).toBe(`med/round_7/candidates/${PEER}/adapter_weights.pkl`);
    expect(sub.velocityS3Key).toBe(`med/round_7/candidates/${PEER}/velocity.pkl`);
    expect(sub.invariants.acceptedPeerIds).toEqual(['p1', 'p2']);

    // commit + reveal both posted, in order
    expect(httpPost).toHaveBeenCalledTimes(2);
    const [commitCall, revealCall] = httpPost.mock.calls;
    expect(commitCall[0]).toBe('https://coord/diloco/med/aggregation-commit');
    expect(revealCall[0]).toBe('https://coord/diloco/med/aggregation-result');
  });

  it('reports the coord-provided ATTEMPT-UNIQUE candidate keys verbatim (no rebuild) so the reveal key == the PUT URL object', async () => {
    // The coord scopes the candidate key by the attempt-unique workOrderId and
    // ships it in the payload. The node must report THAT key (not rebuild a
    // round-level key) so a later redispatch (different key) can never
    // overwrite the immutable object this reveal points to.
    const attemptAdapterKey = `med/round_7/candidates/${PEER}/wo_diloco_agg_X_42_abcdef/adapter_weights.pkl`;
    const attemptVelocityKey = `med/round_7/candidates/${PEER}/wo_diloco_agg_X_42_abcdef/velocity.pkl`;
    const putAdapterUrl = `https://s3.example.com/${attemptAdapterKey}?sig=UA2`;
    const putVelocityUrl = `https://s3.example.com/${attemptVelocityKey}?sig=UV2`;
    const payload = basePayload({
      adapterS3Key: attemptAdapterKey,
      velocityS3Key: attemptVelocityKey,
      adapterUploadUrl: putAdapterUrl,
      velocityUploadUrl: putVelocityUrl,
    });
    const { httpIO, puts } = makeHttpIO(objectsFor(payload));
    const opts = makeOptions({ httpIO, httpPost: jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' })), workDir });

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_attempt', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      opts,
    );

    // Reported keys == coord-provided keys == the objects behind the PUT URLs.
    expect(sub.adapterS3Key).toBe(attemptAdapterKey);
    expect(sub.velocityS3Key).toBe(attemptVelocityKey);
    expect(puts.map((p) => p.url).sort()).toEqual([putAdapterUrl, putVelocityUrl].sort());
    // The reveal carries the attempt-unique key the coord will hash on verify.
    const revealBody = (opts.httpPost as jest.Mock).mock.calls[1][2] as Record<string, unknown>;
    expect(revealBody.adapterS3Key).toBe(attemptAdapterKey);
  });

  it('commit body carries commitment == sha256(canonicalEnvelope || nonce)', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const opts = makeOptions({ httpIO, httpPost, workDir });

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
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const opts = makeOptions({ httpIO, httpPost, workDir });

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_3', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      opts,
    );

    const revealBody = httpPost.mock.calls[1][2] as Record<string, unknown>;
    expect(revealBody.nonce).toBe(sub.nonce);
    expect(revealBody.aggregatorPeerId).toBe(PEER);
    expect(revealBody.adapterSha256).toBe(sub.adapterSha256);
    expect(revealBody.acceptedPeerIds).toEqual(['p1', 'p2']);
    // Phase 2: the reveal carries perPeerCosine UNDER the commitment, so the
    // coord's recompute (mirrored here) MUST feed it back in or the hash
    // diverges. Assert the reveal carried it, then include it in the recompute
    // exactly as the coord does.
    expect(revealBody.perPeerCosine).toEqual({ p1: 0.95, p2: 0.91 });
    // a reveal body carries the same fields the coord recomputes the commitment from
    const recomputed = computeCommitment(
      {
        avgGradientNorm: revealBody.avgGradientNorm as number,
        velocityNorm: revealBody.velocityNorm as number,
        acceptedPeerIds: revealBody.acceptedPeerIds as string[],
        rejectedPeerIds: revealBody.rejectedPeerIds as Array<{ peerId: string; reason: string }>,
        adapterSha256: revealBody.adapterSha256 as string,
        perPeerCosine: revealBody.perPeerCosine as Record<string, number | 'NaN'>,
      },
      revealBody.nonce as string,
    );
    expect(recomputed).toBe(sub.commitment);
  });

  it('reveal carries a non-empty body signature AND a transport X-Signature header (both required)', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await runDiLoCoAggregation(
      { workOrderId: 'wo_diloco_agg_sig', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, workDir }),
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
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await runDiLoCoAggregation(
      { workOrderId: 'wo_sig_parity', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, workDir }),
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
    const message = `${PEER}:${headers['X-Timestamp']}:POST:/diloco/med/aggregation-result:${bodyHash}`;
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
    const { httpIO, puts } = makeHttpIO(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));

    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_g', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, runScript, httpPost, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('fails closed on prevAdapter sha256 mismatch', async () => {
    const payload = basePayload();
    payload.prevAdapter = { s3Key: payload.prevAdapter!.s3Key, sha256: 'e'.repeat(64), downloadUrl: URL_PREV_ADAPTER };
    const { httpIO, puts } = makeHttpIO(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_pa', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, runScript, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('fails closed on prevVelocity sha256 mismatch', async () => {
    const payload = basePayload();
    payload.prevVelocity = { s3Key: payload.prevVelocity!.s3Key, sha256: 'd'.repeat(64), downloadUrl: URL_PREV_VELOCITY };
    const { httpIO, puts } = makeHttpIO(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_pv', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, runScript, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  // ── HTTP fail-closed: 403/expired presigned URL (P35) ───────────────────────

  it('fails closed on a 403/expired download URL — no script, no upload, no commit', async () => {
    const payload = basePayload();
    // Map every input URL EXCEPT one gradient → simulate the runner's HTTP
    // GET on an expired URL raising a typed error (S3 returns 403 on an
    // expired presigned URL).
    const httpIO: DiLoCoAggregationHttpIO = {
      async getUrl(url: string): Promise<Buffer> {
        if (url === URL_GRAD_A) return gradBufA;
        throw new DiLoCoAggregationError(`HTTP GET (presigned) returned 403`, 'download');
      },
      putUrl: jest.fn(),
    };
    const runScript = jest.fn(makeRunScript());
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_403', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, runScript, httpPost, workDir }),
      ),
    ).rejects.toThrow(/returned 403/);
    expect(runScript).not.toHaveBeenCalled();
    expect(httpIO.putUrl).not.toHaveBeenCalled();
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('fails closed on a non-2xx upload PUT (expired candidate URL) — no commit', async () => {
    const payload = basePayload();
    const httpIO: DiLoCoAggregationHttpIO = {
      async getUrl(url: string): Promise<Buffer> {
        const o = objectsFor(payload);
        const b = o[url];
        if (!b) throw new DiLoCoAggregationError(`no url ${url}`, 'download');
        return b;
      },
      async putUrl(): Promise<void> {
        throw new DiLoCoAggregationError(`HTTP PUT (presigned) returned 403`, 'upload');
      },
    };
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_put403', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, httpPost, workDir }),
      ),
    ).rejects.toThrow(/returned 403/);
    expect(httpPost).not.toHaveBeenCalled();
  });

  // ── round-0 null handling (§2 cold start) ────────────────────────────────────

  it('round 0: null prevAdapter + null prevVelocity handled (no download of either)', async () => {
    const payload = basePayload({ outerRound: 0, prevAdapter: null, prevVelocity: null });
    const objects = {
      [payload.gradients[0].downloadUrl]: gradBufA,
      [payload.gradients[1].downloadUrl]: gradBufB,
    };
    const getUrl = jest.fn(async (url: string) => {
      const b = objects[url];
      if (!b) throw new DiLoCoAggregationError(`no url ${url}`, 'download');
      return b;
    });
    const httpIO: DiLoCoAggregationHttpIO = { getUrl, putUrl: jest.fn() };
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));

    const sub = await runDiLoCoAggregation(
      { workOrderId: 'wo_r0', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, workDir }),
    );
    // only the two gradient URLs were downloaded (no prevAdapter/prevVelocity)
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(sub.adapterS3Key).toBe(`med/round_0/candidates/${PEER}/adapter_weights.pkl`);
    expect(httpPost).toHaveBeenCalledTimes(2);
  });

  // ── identity / signer cross-check (P2) ───────────────────────────────────────

  it('fails closed when identity peerId != runtime peerId (never sign for another peer)', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_id', peerId: 'OTHERPEER', coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, workDir }),
      ),
    ).rejects.toThrow(/Identity peerId .* != runtime peerId/);
  });

  // ── payload fail-closed: missing presigned URLs ───────────────────────────────

  it('fails closed when a gradient downloadUrl is missing', async () => {
    const payload = basePayload();
    (payload.gradients[0] as { downloadUrl?: string }).downloadUrl = '';
    const { httpIO } = makeHttpIO(objectsFor(payload));
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_nourl', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, workDir }),
      ),
    ).rejects.toThrow(/downloadUrl must be an http/);
  });

  it('fails closed when adapterUploadUrl is missing', async () => {
    const payload = basePayload();
    (payload as { adapterUploadUrl?: string }).adapterUploadUrl = '';
    const { httpIO } = makeHttpIO(objectsFor(payload));
    await expect(
      runDiLoCoAggregation(
        { workOrderId: 'wo_noput', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, workDir }),
      ),
    ).rejects.toThrow(/adapterUploadUrl must be an http/);
  });

  // ── script error surfaces as abort ───────────────────────────────────────────

  it('aborts when the script returns an error key (no commit/reveal)', async () => {
    const payload = basePayload();
    const { httpIO, puts } = makeHttpIO(objectsFor(payload));
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
        makeOptions({ httpIO, httpPost, runScript, workDir }),
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
  it('isHttpUrl accepts http(s), rejects non-URL / non-http', () => {
    expect(__internal.isHttpUrl('https://s3.example.com/x?sig=1')).toBe(true);
    expect(__internal.isHttpUrl('http://localhost:9000/x')).toBe(true);
    expect(__internal.isHttpUrl('med/round_7/p1.pt')).toBe(false);
    expect(__internal.isHttpUrl('s3://bucket/key')).toBe(false);
    expect(__internal.isHttpUrl('')).toBe(false);
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
