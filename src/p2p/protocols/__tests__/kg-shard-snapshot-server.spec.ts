/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Workstream F2 — node-side KG_SHARD_SNAPSHOT server handler spec. Exercises
 * the full fail-closed verify chain (steps 1-6) plus the happy path. Uses a
 * TEST coord keypair to mint valid attestations (its raw pubkey is passed as
 * the handler's `coordinatorPubkey` trust anchor) and a TEST app keypair to
 * sign the `req|<shardId>|<publishedAtMs>` request signature.
 *
 * No real libp2p: the stream is a stub that yields one inbound request frame
 * and captures every outbound frame so we can assert NOT_AUTHORIZED /
 * BAD_REQUEST and that NO shard record bytes were streamed on any reject path.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { generateKeyPairSync, sign as nodeSign } from 'crypto';

import { KgShardStorage, type SnapshotRecord } from '../../kg-shard/KgShardStorage';
import { ReplayGuard } from '../../topics/replay-guard';
import { DOMAIN_PEER_IDENTITY_ATTESTATION } from '../../topics/verify-coordinator-envelope';
import { sign as appSign } from '../../../modules/identity/identity';
import * as identityModule from '../../../modules/identity/identity';
import {
  makeKgShardSnapshotServerHandler,
  type KgShardSnapshotServerDeps,
} from '../kg-shard-snapshot-server';
import type {
  SnapshotAttestation,
  SnapshotDone,
  SnapshotError,
  SnapshotRequest,
} from '../kg-shard-snapshot';

// ── crypto helpers ─────────────────────────────────────────────────────────

interface CoordKeyPair {
  rawPubKey: Uint8Array;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeCoordKeyPair(): CoordKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { rawPubKey: der.subarray(12), privateKey };
}

/** Raw 32-byte hex app keypair (matches `IdentityHelper.sign/verifySignature`
 *  raw-hex contract). */
function makeAppKeyPair(): { privHex: string; pubHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const pubDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    privHex: privDer.subarray(-32).toString('hex'),
    pubHex: pubDer.subarray(-32).toString('hex'),
  };
}

/** Mint a base64 coord attestation signature over `{ domain, body, ts }`. */
function signAttestation(
  body: SnapshotAttestation['body'],
  ts: number,
  coordPriv: CoordKeyPair['privateKey'],
): string {
  const signedBytes = Buffer.from(
    JSON.stringify({ domain: DOMAIN_PEER_IDENTITY_ATTESTATION, body, ts }),
    'utf8',
  );
  return Buffer.from(nodeSign(null, signedBytes, coordPriv)).toString('base64');
}

// ── stream stub ──────────────────────────────────────────────────────────

interface FakeStream {
  outFrames: Uint8Array[];
  send(b: Uint8Array): boolean;
  closeWrite(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

function frameBytes(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + json.byteLength);
  new DataView(out.buffer, out.byteOffset, 4).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  return out;
}

function buildStream(inbound: Uint8Array): FakeStream {
  const outFrames: Uint8Array[] = [];
  let yielded = false;
  const stream: FakeStream = {
    outFrames,
    send(b: Uint8Array): boolean {
      outFrames.push(new Uint8Array(b));
      return true;
    },
    async closeWrite(): Promise<void> {
      /* noop */
    },
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (yielded) return { value: undefined as any, done: true };
          yielded = true;
          return { value: inbound, done: false };
        },
      };
    },
  };
  return stream;
}

/** Build a stream that yields an arbitrary RAW byte sequence as its single
 *  inbound chunk — bypasses `frameBytes` so a test can feed a hostile header
 *  (e.g. an over-large declared length) that makes `readJsonFromStream` throw. */
function buildStreamRaw(bytes: Uint8Array): FakeStream {
  return buildStream(bytes);
}

/** Decode the captured outbound frames into JSON objects. */
function decodeOut<T = any>(stream: FakeStream): T[] {
  let total = 0;
  for (const f of stream.outFrames) total += f.byteLength;
  const all = new Uint8Array(total);
  let off = 0;
  for (const f of stream.outFrames) {
    all.set(f, off);
    off += f.byteLength;
  }
  const frames: T[] = [];
  let pos = 0;
  while (pos + 4 <= all.byteLength) {
    const len = new DataView(all.buffer, all.byteOffset + pos, 4).getUint32(0, true);
    if (pos + 4 + len > all.byteLength) break;
    frames.push(JSON.parse(new TextDecoder().decode(all.subarray(pos + 4, pos + 4 + len))) as T);
    pos += 4 + len;
  }
  return frames;
}

function makeRecord(i: number): SnapshotRecord {
  return {
    embeddingId: `emb-${i}`,
    shardId: 0,
    vector: new Array(768).fill(0).map((_, j) => (i + j) * 0.001),
    sourceType: 'pubmed',
    sourceId: `src-${i}`,
    domain: 'medical',
    evidenceLevel: null,
    createdAtMs: 1_700_000_000_000 + i,
  };
}

// ── fixtures ───────────────────────────────────────────────────────────────

const REMOTE_PEER = '12D3KooWRemotePeerForServerSpec0000000000000000000000';
const SHARD_ID = 0;

let tmpDir: string;
let storage: KgShardStorage;
let coord: CoordKeyPair;
let app: ReturnType<typeof makeAppKeyPair>;

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'kg-snapshot-server-test-'));
  storage = new KgShardStorage(tmpDir);
  coord = makeCoordKeyPair();
  app = makeAppKeyPair();
  // Seed the shard with two records so a happy path streams real bytes.
  await storage.appendMany(SHARD_ID, [makeRecord(1), makeRecord(2)]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDeps(over: Partial<KgShardSnapshotServerDeps> = {}): KgShardSnapshotServerDeps {
  return {
    storage,
    coordinatorPubkey: coord.rawPubKey,
    replayGuard: new ReplayGuard(5 * 60),
    ...over,
  };
}

/** Build a fully-valid request for `peerId` (defaults to the connection's
 *  remotePeer) signed by the test app key, attested by the test coord key. */
async function buildValidRequest(opts: {
  peerId?: string;
  verified?: boolean;
  attTs?: number;
  publishedAtMs?: number;
  appPubkey?: string;
  reqSigPrivHex?: string;
  attSig?: string;
} = {}): Promise<SnapshotRequest> {
  const publishedAtMs = opts.publishedAtMs ?? Date.now();
  const appPubkey = opts.appPubkey ?? app.pubHex;
  const reqPriv = opts.reqSigPrivHex ?? app.privHex;
  const signature = await appSign(`req|${SHARD_ID}|${publishedAtMs}`, reqPriv);
  const body: SnapshotAttestation['body'] = {
    p2pPeerId: opts.peerId ?? REMOTE_PEER,
    appPubkey,
    verified: opts.verified ?? true,
  };
  const ts = opts.attTs ?? Math.floor(Date.now() / 1000);
  const sig = opts.attSig ?? signAttestation(body, ts, coord.privateKey);
  return { shardId: SHARD_ID, signature, publishedAtMs, attestation: { body, ts, sig } };
}

function runHandler(
  req: unknown,
  deps: KgShardSnapshotServerDeps = makeDeps(),
  remotePeer: string = REMOTE_PEER,
): Promise<{ frames: any[] }> {
  const stream = buildStream(frameBytes(req));
  const conn = { remotePeer: { toString: () => remotePeer } };
  const handler = makeKgShardSnapshotServerHandler(deps);
  return handler(stream, conn).then(() => ({ frames: decodeOut(stream) }));
}

/** Assert the frames are a clean reject with the expected error and that NO
 *  shard record frame leaked (only the error frame is present). */
function expectReject(frames: any[], error: SnapshotError['error']): void {
  expect(frames.length).toBe(1);
  expect(frames[0].error).toBe(error);
  expect(frames[0].embeddingId).toBeUndefined();
  expect(frames[0].done).toBeUndefined();
}

// ── construction guards ──────────────────────────────────────────────────

describe('makeKgShardSnapshotServerHandler — construction (non-@Optional deps)', () => {
  it('throws when storage is missing', () => {
    expect(() => makeKgShardSnapshotServerHandler(makeDeps({ storage: undefined as any })))
      .toThrow(/storage is required/);
  });
  it('throws when coordinatorPubkey is wrong length', () => {
    expect(() =>
      makeKgShardSnapshotServerHandler(makeDeps({ coordinatorPubkey: new Uint8Array(16) })),
    ).toThrow(/coordinatorPubkey/);
  });
  it('throws when replayGuard is missing', () => {
    expect(() => makeKgShardSnapshotServerHandler(makeDeps({ replayGuard: undefined as any })))
      .toThrow(/replayGuard is required/);
  });
});

// ── happy path ─────────────────────────────────────────────────────────────

describe('KG_SHARD_SNAPSHOT server — happy path', () => {
  it('streams the shard when attestation + conn + req-sig + freshness all valid', async () => {
    const req = await buildValidRequest();
    const { frames } = await runHandler(req);

    const records = frames.filter((f) => f.embeddingId);
    const done = frames.find((f): f is SnapshotDone => f.done === true);
    expect(records.map((r) => r.embeddingId)).toEqual(['emb-1', 'emb-2']);
    expect(done).toBeTruthy();
    expect(done!.total).toBe(2);
    expect(frames.some((f) => f.error)).toBe(false);
  });
});

// ── reject paths (steps 1-6) ────────────────────────────────────────────────

describe('KG_SHARD_SNAPSHOT server — fail-closed reject paths', () => {
  it('step 1: BAD_REQUEST on a malformed request (missing attestation)', async () => {
    const req = await buildValidRequest();
    const { attestation: _drop, ...noAtt } = req;
    const { frames } = await runHandler(noAtt);
    expectReject(frames, 'BAD_REQUEST');
  });

  it('step 1: BAD_REQUEST on wrong-typed shardId', async () => {
    const req = await buildValidRequest();
    const { frames } = await runHandler({ ...req, shardId: 'oops' });
    expectReject(frames, 'BAD_REQUEST');
  });

  // Exercise each individual `shapeCheck` guard arm (server.ts:106-126) so a
  // single malformed/missing/wrong-typed field fails closed on its own branch.
  it.each<[string, (r: SnapshotRequest) => unknown]>([
    ['raw is not an object', () => 'not-an-object'],
    ['shardId negative', (r) => ({ ...r, shardId: -1 })],
    ['shardId NaN', (r) => ({ ...r, shardId: Number.NaN })],
    ['shardId non-integer', (r) => ({ ...r, shardId: 1.5 })],
    ['signature non-hex', (r) => ({ ...r, signature: 'not-hex-zz' })],
    ['publishedAtMs not a number', (r) => ({ ...r, publishedAtMs: 'soon' })],
    ['attestation.ts not a number', (r) => ({ ...r, attestation: { ...r.attestation, ts: 'now' } })],
    ['attestation.sig empty', (r) => ({ ...r, attestation: { ...r.attestation, sig: '' } })],
    ['body not an object', (r) => ({ ...r, attestation: { ...r.attestation, body: null } })],
    ['body.p2pPeerId empty', (r) => ({ ...r, attestation: { ...r.attestation, body: { ...r.attestation.body, p2pPeerId: '' } } })],
    ['body.appPubkey non-hex', (r) => ({ ...r, attestation: { ...r.attestation, body: { ...r.attestation.body, appPubkey: 'zz' } } })],
    ['body.verified not a boolean', (r) => ({ ...r, attestation: { ...r.attestation, body: { ...r.attestation.body, verified: 'yes' } } })],
  ])('step 1: BAD_REQUEST on malformed shape — %s', async (_label, mutate) => {
    const req = await buildValidRequest();
    const { frames } = await runHandler(mutate(req));
    expectReject(frames, 'BAD_REQUEST');
  });

  it('step 3: NOT_AUTHORIZED when the connection has no resolvable remotePeer', async () => {
    // `connection.remotePeer?.toString?.() ?? '<unknown>'` (server.ts:187-188)
    // falls back to '<unknown>', which never matches the attested p2pPeerId, so
    // the bind check (step 3) rejects — proving a peerless connection can't pull.
    const req = await buildValidRequest();
    const stream = buildStream(frameBytes(req));
    await makeKgShardSnapshotServerHandler(makeDeps())(stream, {});
    expectReject(decodeOut(stream), 'NOT_AUTHORIZED');
  });

  it('step 2: NOT_AUTHORIZED on a forged attestation signature', async () => {
    const req = await buildValidRequest({ attSig: Buffer.alloc(64, 7).toString('base64') });
    const { frames } = await runHandler(req);
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 2: NOT_AUTHORIZED on an attestation signed by a DIFFERENT coord key', async () => {
    const wrongCoord = makeCoordKeyPair();
    const body = { p2pPeerId: REMOTE_PEER, appPubkey: app.pubHex, verified: true };
    const ts = Math.floor(Date.now() / 1000);
    const sig = signAttestation(body, ts, wrongCoord.privateKey);
    const publishedAtMs = Date.now();
    const signature = await appSign(`req|${SHARD_ID}|${publishedAtMs}`, app.privHex);
    const req = { shardId: SHARD_ID, signature, publishedAtMs, attestation: { body, ts, sig } };
    const { frames } = await runHandler(req);
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 2: NOT_AUTHORIZED on an expired attestation (ts older than 24h)', async () => {
    const attTs = Math.floor(Date.now() / 1000) - 86_401;
    const req = await buildValidRequest({ attTs });
    const { frames } = await runHandler(req);
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 3: NOT_AUTHORIZED when attestation.p2pPeerId != conn.remotePeer', async () => {
    // Attestation is valid + minted for REMOTE_PEER, but the connection is a
    // DIFFERENT peer (stolen-attestation-replayed-on-another-connection).
    const req = await buildValidRequest({ peerId: REMOTE_PEER });
    const { frames } = await runHandler(req, makeDeps(), 'SomeOtherPeerThatStoleIt');
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 4: NOT_AUTHORIZED when verified === false', async () => {
    const req = await buildValidRequest({ verified: false });
    const { frames } = await runHandler(req);
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 5: NOT_AUTHORIZED on a forged req-sig (signed by a DIFFERENT app key)', async () => {
    const otherApp = makeAppKeyPair();
    // Attestation attests `app.pubHex`, but the req is signed by otherApp.
    const req = await buildValidRequest({ reqSigPrivHex: otherApp.privHex });
    const { frames } = await runHandler(req);
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 5: NOT_AUTHORIZED when the attested appPubkey does not match the req-signer', async () => {
    // appPubkey in the attestation is a stranger's; the req is signed by app.
    const stranger = makeAppKeyPair();
    const req = await buildValidRequest({ appPubkey: stranger.pubHex });
    const { frames } = await runHandler(req);
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 6: BAD_REQUEST on a stale publishedAtMs (older than ±5min)', async () => {
    const req = await buildValidRequest({ publishedAtMs: Date.now() - 6 * 60_000 });
    const { frames } = await runHandler(req);
    expectReject(frames, 'BAD_REQUEST');
  });

  it('step 6: NOT_AUTHORIZED on a replayed request signature', async () => {
    const deps = makeDeps(); // shared guard across both calls
    const req = await buildValidRequest();
    const first = await runHandler(req, deps);
    // First call serves successfully.
    expect(first.frames.some((f) => f.done === true)).toBe(true);
    // Replaying the SAME request (same sig) is rejected.
    const second = await runHandler(req, deps);
    expectReject(second.frames, 'NOT_AUTHORIZED');
  });

  it('step 5: NOT_AUTHORIZED on a too-short req signature (sigLenOk fails)', async () => {
    // A 16-hex-char signature passes `shapeCheck` (isHex, no length bound) and
    // the attestation envelope verify, but `Buffer.from(sig,'hex').length` is 8
    // (!== 64) so the sigLenOk/pubLenOk guard (server.ts:247-249) trips BEFORE
    // any verifier call → NOT_AUTHORIZED, with no shard bytes served.
    const req = await buildValidRequest();
    const { frames } = await runHandler({ ...req, signature: 'deadbeefdeadbeef' });
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 5: NOT_AUTHORIZED on a wrong-length attested appPubkey (pubLenOk fails)', async () => {
    // Same length guard, pubkey arm: a 16-hex-char appPubkey is valid hex but
    // decodes to 8 bytes (!== 32) → pubLenOk false → NOT_AUTHORIZED.
    const req = await buildValidRequest({ appPubkey: 'deadbeefdeadbeef' });
    const { frames } = await runHandler(req);
    expectReject(frames, 'NOT_AUTHORIZED');
  });

  it('step 1: BAD_REQUEST when the stream read throws (over-large declared frame length)', async () => {
    // A raw 4-byte LE header declaring length 0xFFFFFFFF (> MAX_FRAME_BYTES =
    // 1<<20, stream-codec.ts:65-66) makes `readJsonFromStream` throw, exercising
    // the step-1 read catch (server.ts:194-196) → BAD_REQUEST, no shard served.
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 0xffffffff, true);
    const stream = buildStreamRaw(header);
    const conn = { remotePeer: { toString: () => REMOTE_PEER } };
    await makeKgShardSnapshotServerHandler(makeDeps())(stream, conn);
    expectReject(decodeOut(stream), 'BAD_REQUEST');
  });

  it('step 8: INTERNAL when serving a VALID request and storage.read throws (no done frame)', async () => {
    // Drive a fully-valid request through steps 1-7, then make the disk read
    // fail so `streamShard` throws → the serve catch (server.ts:288-296) emits a
    // single INTERNAL frame and NEVER a `done` frame.
    const failingStorage = {
      ...storage,
      read: jest.fn().mockRejectedValue(new Error('disk')),
    } as unknown as KgShardStorage;
    const req = await buildValidRequest();
    const { frames } = await runHandler(req, makeDeps({ storage: failingStorage }));
    expectReject(frames, 'INTERNAL');
  });

  it('step 5: NOT_AUTHORIZED when verifySignature throws (defensive inner catch)', async () => {
    // The REAL `verifySignature` self-catches a bad input and returns false, so
    // it can never throw in prod — the inner try/catch at server.ts:253-257 is
    // purely defensive. The handler reads the binding off the module at
    // call-time, so spying lets us force a throw and prove that defensive catch
    // sets `reqSigValid = false` → a single NOT_AUTHORIZED frame, no done frame.
    const spy = jest
      .spyOn(identityModule, 'verifySignature')
      .mockRejectedValueOnce(new Error('boom'));
    try {
      const req = await buildValidRequest();
      const { frames } = await runHandler(req);
      expectReject(frames, 'NOT_AUTHORIZED');
    } finally {
      spy.mockRestore();
    }
  });

  it('outer catch: INTERNAL when an unexpected throw escapes all inner guards', async () => {
    // `replayGuard.seenBefore` runs at server.ts:271 — OUTSIDE every inner
    // try/catch. Forcing it to throw on a fully-valid request reaches the
    // last-resort outer catch (server.ts:310-322), which converts the throw
    // into a single INTERNAL 'internal error' frame and serves no shard bytes.
    const guard = new ReplayGuard(5 * 60);
    jest.spyOn(guard, 'seenBefore').mockImplementation(() => {
      throw new Error('guard exploded');
    });
    const req = await buildValidRequest();
    const { frames } = await runHandler(req, makeDeps({ replayGuard: guard }));
    expectReject(frames, 'INTERNAL');
  });
});
