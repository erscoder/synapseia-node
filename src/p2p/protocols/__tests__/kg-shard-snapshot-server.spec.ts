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
});
