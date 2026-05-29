/**
 * DiLoCo B-validator runner tests (node-side, Phase 4B).
 *
 * The presigned-URL HTTP I/O, the python script, identity and the signed POST
 * are all injected (test seams) so these run fast + offline. The node holds NO
 * AWS creds: every input is fetched via the coord-presigned `downloadUrl`. The
 * python forward pass itself is covered separately by
 * `scripts/__tests__/diloco_validate_test.py`.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  runDiLoCoValidation,
  DiLoCoValidationError,
  __internal,
  type DiLoCoValidationWorkOrderPayload,
  type RunDiLoCoValidationOptions,
} from '../diloco_validation_runner';
import { canonicalJSON } from '../diloco-aggregation-commitment';
import type { DiLoCoAggregationHttpIO } from '../diloco-aggregation-http';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const PEER = 'valpeer123';

const gradBufA = Buffer.from('gradient-A-bytes');
const gradBufB = Buffer.from('gradient-B-bytes');
const prevAdapBuf = Buffer.from('prev-adapter-bytes');
const valSetBuf = Buffer.from('held-out-val-set-bytes');

const URL_GRAD_A = 'https://s3.example.com/med/round_7/gradients/p1.pt?sig=A';
const URL_GRAD_B = 'https://s3.example.com/med/round_7/gradients/p2.pt?sig=B';
const URL_PREV_ADAPTER = 'https://s3.example.com/med/latest/adapter_weights.pkl?sig=PA';
const URL_VAL_SET = 'https://s3.example.com/med/round_7/valset.jsonl?sig=VS';

function makeHttpIO(objects: Record<string, Buffer>): {
  httpIO: DiLoCoAggregationHttpIO;
} {
  const httpIO: DiLoCoAggregationHttpIO = {
    async getUrl(url: string): Promise<Buffer> {
      const buf = objects[url];
      if (!buf) throw new DiLoCoValidationError(`no such url ${url}`, 'download');
      return buf;
    },
    async putUrl(): Promise<void> {
      /* validator never uploads */
    },
  };
  return { httpIO };
}

function basePayload(over: Partial<DiLoCoValidationWorkOrderPayload> = {}): DiLoCoValidationWorkOrderPayload {
  return {
    roundId: 'diloco_med_7_1700000000000',
    domain: 'med',
    outerRound: 7,
    modelId: 'Qwen/Qwen2.5-7B-Instruct',
    prevAdapter: { s3Key: 'med/latest/adapter_weights.pkl', sha256: sha(prevAdapBuf), downloadUrl: URL_PREV_ADAPTER },
    gradients: [
      { peerId: 'p1', s3Key: 'med/round_7/gradients/p1.pt', sha256: sha(gradBufA), downloadUrl: URL_GRAD_A },
      { peerId: 'p2', s3Key: 'med/round_7/gradients/p2.pt', sha256: sha(gradBufB), downloadUrl: URL_GRAD_B },
    ],
    valSet: { downloadUrl: URL_VAL_SET, sha256: sha(valSetBuf), sampleCount: 128 },
    deadlineMs: 1700000900000,
    ...over,
  };
}

const objectsFor = (p: DiLoCoValidationWorkOrderPayload): Record<string, Buffer> => {
  const o: Record<string, Buffer> = {
    [p.gradients[0].downloadUrl]: gradBufA,
    [p.gradients[1].downloadUrl]: gradBufB,
    [p.valSet.downloadUrl]: valSetBuf,
  };
  if (p.prevAdapter) o[p.prevAdapter.downloadUrl] = prevAdapBuf;
  return o;
};

// A script double returning a perPeerValLoss map (one genuine number + one
// "NaN" peer that the script could not evaluate).
function makeRunScript(
  map: Record<string, number | 'NaN'> = { p1: 2.4137, p2: 'NaN' },
): RunDiLoCoValidationOptions['runScript'] {
  return async () => ({ perPeerValLoss: map });
}

// Real ed25519 keypair so the signature-parity tests verify against the
// matching public key.
const PRIV_HEX = '22'.repeat(32);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _ed = require('@noble/ed25519');
const { sha512: _sha512 } = require('@noble/hashes/sha2.js');
(_ed.hashes as Record<string, unknown>).sha512 = _sha512;
const PUB_HEX = Buffer.from(_ed.getPublicKey(new Uint8Array(Buffer.from(PRIV_HEX, 'hex')))).toString('hex');
const identity = { privateKeyHex: PRIV_HEX, publicKeyHex: PUB_HEX, peerId: PEER };

function makeOptions(over: Partial<RunDiLoCoValidationOptions> = {}): RunDiLoCoValidationOptions {
  return {
    httpIO: makeHttpIO({}).httpIO,
    identity,
    runScript: makeRunScript(),
    httpPost: jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' })),
    workDir: undefined,
    ...over,
  };
}

describe('runDiLoCoValidation', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlval-test-'));
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('happy path: downloads via presigned URLs, runs, POSTs the EXACT 4A body shape (incl a "NaN" peer)', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const opts = makeOptions({ httpIO, httpPost, workDir });

    const sub = await runDiLoCoValidation(
      { workOrderId: 'wo_diloco_val_1', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      opts,
    );

    expect(sub.validatorPeerId).toBe(PEER);
    expect(sub.perPeerValLoss).toEqual({ p1: 2.4137, p2: 'NaN' });

    // POST once, to the §4A endpoint.
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [url, , body] = httpPost.mock.calls[0];
    expect(url).toBe('https://coord/diloco/med/validation-result');

    // The body MUST byte-match the 4A contract: exactly these 4 keys, NO
    // validatorWallet, the "NaN" peer carried as the literal string.
    const b = body as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(['perPeerValLoss', 'roundId', 'signature', 'validatorPeerId']);
    expect(b).not.toHaveProperty('validatorWallet');
    expect(b.roundId).toBe(payload.roundId);
    expect(b.validatorPeerId).toBe(PEER);
    expect(b.perPeerValLoss).toEqual({ p1: 2.4137, p2: 'NaN' });
    expect(typeof b.signature).toBe('string');
    expect((b.signature as string).length).toBeGreaterThan(0);
  });

  it('signs a VERIFIABLE Ed25519 body content signature over canonicalJSON({perPeerValLoss, roundId})', async () => {
    const ed = await import('@noble/ed25519');
    const { sha512 } = await import('@noble/hashes/sha2.js');
    (ed.hashes as Record<string, unknown>).sha512 = sha512;

    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const sub = await runDiLoCoValidation(
      { workOrderId: 'wo_val_sig', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, workDir }),
    );

    // Recompute the EXACT signed bytes the coord verifies and confirm the
    // signature checks out against the matching public key.
    const canonical = canonicalJSON({ perPeerValLoss: sub.perPeerValLoss, roundId: sub.roundId });
    const ok = ed.verify(
      // IdentityHelper.sign returns hex; node-crypto Ed25519 sigs are 64 bytes.
      new Uint8Array(Buffer.from(sub.signature, 'hex')),
      new TextEncoder().encode(canonical),
      new Uint8Array(Buffer.from(identity.publicKeyHex, 'hex')),
    );
    expect(ok).toBe(true);
    // Sanity: the body's signature == the returned submission signature.
    const body = httpPost.mock.calls[0][2] as { signature: string };
    expect(body.signature).toBe(sub.signature);
  });

  it('transport X-Signature is computed over the FULL posted body (NodeSignatureGuard parity)', async () => {
    const ed = await import('@noble/ed25519');
    const { sha256, sha512 } = await import('@noble/hashes/sha2.js');
    (ed.hashes as Record<string, unknown>).sha512 = sha512;

    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await runDiLoCoValidation(
      { workOrderId: 'wo_val_transport', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, workDir }),
    );
    const headers = httpPost.mock.calls[0][1] as Record<string, string>;
    const body = httpPost.mock.calls[0][2];

    expect(headers['X-Peer-Id']).toBe(PEER);
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
    const message = `${PEER}:${headers['X-Timestamp']}:POST:/diloco/med/validation-result:${bodyHash}`;
    const ok = ed.verify(
      new Uint8Array(Buffer.from(headers['X-Signature'], 'base64')),
      new TextEncoder().encode(message),
      new Uint8Array(Buffer.from(identity.publicKeyHex, 'hex')),
    );
    expect(ok).toBe(true);
  });

  it('a per-peer failure surfaces as the literal "NaN" string, not a crash', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    // Script returns one number + one "NaN" peer (the one it could not eval).
    const sub = await runDiLoCoValidation(
      { workOrderId: 'wo_val_nan', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, runScript: makeRunScript({ p1: 1.23, p2: 'NaN' }), workDir }),
    );
    expect(sub.perPeerValLoss.p2).toBe('NaN');
    expect(sub.perPeerValLoss.p1).toBe(1.23);
  });

  it('normalizes a non-finite numeric valLoss to the "NaN" string (defensive contract guard)', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const sub = await runDiLoCoValidation(
      { workOrderId: 'wo_val_inf', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({
        httpIO,
        // A buggy/old script emits Infinity as a number — must collapse to "NaN".
        runScript: makeRunScript({ p1: Infinity as unknown as number, p2: 3.3 }),
        workDir,
      }),
    );
    expect(sub.perPeerValLoss.p1).toBe('NaN');
    expect(sub.perPeerValLoss.p2).toBe(3.3);
  });

  it('round 0: null prevAdapter handled (only gradients + valSet downloaded)', async () => {
    const payload = basePayload({ outerRound: 0, prevAdapter: null });
    const objects = objectsFor(payload);
    const getUrl = jest.fn(async (url: string) => {
      const b = objects[url];
      if (!b) throw new DiLoCoValidationError(`no url ${url}`, 'download');
      return b;
    });
    const httpIO: DiLoCoAggregationHttpIO = { getUrl, putUrl: jest.fn() };
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));

    await runDiLoCoValidation(
      { workOrderId: 'wo_val_r0', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, workDir }),
    );
    // 2 gradients + 1 valSet, no prevAdapter.
    expect(getUrl).toHaveBeenCalledTimes(3);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it('threads a deterministic maxSeqLen (canonical 512) into the script ScriptInput', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    // Capture the ScriptInput the runner hands to the validation script.
    const runScript = jest.fn(makeRunScript());

    await runDiLoCoValidation(
      { workOrderId: 'wo_val_seqlen', peerId: PEER, coordinatorUrl: 'https://coord', payload },
      makeOptions({ httpIO, httpPost, runScript, workDir }),
    );

    expect(runScript).toHaveBeenCalledTimes(1);
    const scriptInput = runScript.mock.calls[0][0] as Record<string, unknown>;
    // Pinned to diloco_train.py's trainer Dataset max_length=512 / diloco_validate.py DEFAULT_MAX_SEQ_LEN.
    expect(scriptInput.maxSeqLen).toBe(512);
    // maxValSamples still sourced from the WO valSet.sampleCount (regression guard).
    expect(scriptInput.maxValSamples).toBe(payload.valSet.sampleCount);
  });

  // ── sha256 fail-closed for EACH pinned input (P2) ───────────────────────────

  it('fails closed on gradient sha256 mismatch — no script, no POST', async () => {
    const payload = basePayload();
    payload.gradients[1].sha256 = 'f'.repeat(64);
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await expect(
      runDiLoCoValidation(
        { workOrderId: 'wo_g', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, runScript, httpPost, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('fails closed on valSet sha256 mismatch', async () => {
    const payload = basePayload();
    payload.valSet.sha256 = 'e'.repeat(64);
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const runScript = jest.fn(makeRunScript());
    await expect(
      runDiLoCoValidation(
        { workOrderId: 'wo_vs', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, runScript, workDir }),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(runScript).not.toHaveBeenCalled();
  });

  it('fails closed on a 403/expired download URL (P35) — no script, no POST', async () => {
    const payload = basePayload();
    const httpIO: DiLoCoAggregationHttpIO = {
      async getUrl(url: string): Promise<Buffer> {
        if (url === URL_GRAD_A) return gradBufA;
        throw new DiLoCoValidationError(`HTTP GET (presigned) returned 403`, 'download');
      },
      putUrl: jest.fn(),
    };
    const runScript = jest.fn(makeRunScript());
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    await expect(
      runDiLoCoValidation(
        { workOrderId: 'wo_403', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, runScript, httpPost, workDir }),
      ),
    ).rejects.toThrow(/returned 403/);
    expect(runScript).not.toHaveBeenCalled();
    expect(httpPost).not.toHaveBeenCalled();
  });

  // ── identity cross-check (P2) ─────────────────────────────────────────────────

  it('fails closed when identity peerId != runtime peerId (never sign for another peer)', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    await expect(
      runDiLoCoValidation(
        { workOrderId: 'wo_id', peerId: 'OTHERPEER', coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, workDir }),
      ),
    ).rejects.toThrow(/Identity peerId .* != runtime peerId/);
  });

  // ── script error surfaces as abort ─────────────────────────────────────────────

  it('aborts when the script returns an error key (no POST)', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
    const runScript: RunDiLoCoValidationOptions['runScript'] = async () => ({
      error: 'DiLoCo model not cached locally',
      errorType: 'RuntimeError',
    });
    await expect(
      runDiLoCoValidation(
        { workOrderId: 'wo_err', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, httpPost, runScript, workDir }),
      ),
    ).rejects.toThrow(/validation script failed/);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('propagates a non-2xx POST as a typed error', async () => {
    const payload = basePayload();
    const { httpIO } = makeHttpIO(objectsFor(payload));
    const httpPost = jest.fn(async () => ({ ok: false, status: 403, text: async () => 'forbidden' }));
    await expect(
      runDiLoCoValidation(
        { workOrderId: 'wo_post403', peerId: PEER, coordinatorUrl: 'https://coord', payload },
        makeOptions({ httpIO, httpPost, workDir }),
      ),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe('runner internals', () => {
  it('validatePayload rejects empty gradients', () => {
    expect(() => __internal.validatePayload(basePayload({ gradients: [] }))).toThrow(/non-empty/);
  });
  it('validatePayload rejects bad domain', () => {
    expect(() => __internal.validatePayload(basePayload({ domain: '../etc' }))).toThrow(/domain must match/);
  });
  it('validatePayload rejects a non-hex gradient sha', () => {
    const p = basePayload();
    p.gradients[0].sha256 = 'nothex';
    expect(() => __internal.validatePayload(p)).toThrow(/64-char hex/);
  });
  it('validatePayload rejects a valSet without an http(s) downloadUrl', () => {
    const p = basePayload();
    (p.valSet as { downloadUrl: string }).downloadUrl = 'med/round_7/valset.jsonl';
    expect(() => __internal.validatePayload(p)).toThrow(/valSet needs/);
  });
  it('validatePayload rejects a non-positive sampleCount', () => {
    expect(() =>
      __internal.validatePayload(basePayload({ valSet: { downloadUrl: URL_VAL_SET, sha256: sha(valSetBuf), sampleCount: 0 } })),
    ).toThrow(/sampleCount/);
  });
  it('normalizePerPeerValLoss collapses non-finite numbers to the "NaN" string', () => {
    expect(__internal.normalizePerPeerValLoss({ a: 1.5, b: 'NaN', c: NaN, d: Infinity })).toEqual({
      a: 1.5,
      b: 'NaN',
      c: 'NaN',
      d: 'NaN',
    });
  });
  it('isHttpUrl accepts http(s), rejects non-URL / non-http', () => {
    expect(__internal.isHttpUrl('https://s3.example.com/x?sig=1')).toBe(true);
    expect(__internal.isHttpUrl('med/round_7/p1.pt')).toBe(false);
    expect(__internal.isHttpUrl('s3://bucket/key')).toBe(false);
  });
  it('signResult is deterministic for the same map + round + key', async () => {
    const a = await __internal.signResult({ p1: 1.1, p2: 'NaN' }, 'r1', identity);
    const b = await __internal.signResult({ p2: 'NaN', p1: 1.1 }, 'r1', identity);
    // canonicalJSON sorts keys → insertion order does not change the bytes.
    expect(a).toBe(b);
  });
  it('isSafePathSegment rejects traversal', () => {
    expect(__internal.isSafePathSegment('wo_1')).toBe(true);
    expect(__internal.isSafePathSegment('../x')).toBe(false);
    expect(__internal.isSafePathSegment('a/b')).toBe(false);
  });
});
