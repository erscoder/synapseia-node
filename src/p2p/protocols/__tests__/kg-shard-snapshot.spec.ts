/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Plan D.4-distribution.4 — node-side snapshot client spec. Stubs
 * the libp2p stream + dialer so we never touch the real network.
 * Real Ed25519 signing happens via the project `sign` helper so the
 * client truly produces a 64-byte signature on each request.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { generateIdentity, type Identity } from '../../../modules/identity/identity';
import { KgShardStorage, type SnapshotRecord } from '../../kg-shard/KgShardStorage';
import {
  KgShardSnapshotClient,
  KG_SHARD_SNAPSHOT_PROTOCOL,
  type ISnapshotDialer,
  type SnapshotRequest,
  type SnapshotDone,
} from '../kg-shard-snapshot';

interface CapturedFrame { bytes: Uint8Array; }

interface FakeStream {
  outFrames: CapturedFrame[];
  send(b: Uint8Array): boolean;
  closeWrite(): Promise<void>;
  closeWriteCalled: number;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

function frameBytes(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + json.byteLength);
  new DataView(out.buffer, out.byteOffset, 4).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  return out;
}

function decodeOutFrames<T = any>(stream: FakeStream): T[] {
  let total = 0;
  for (const f of stream.outFrames) total += f.bytes.byteLength;
  const all = new Uint8Array(total);
  let off = 0;
  for (const f of stream.outFrames) {
    all.set(f.bytes, off);
    off += f.bytes.byteLength;
  }
  const frames: T[] = [];
  let pos = 0;
  while (pos + 4 <= all.byteLength) {
    const len = new DataView(all.buffer, all.byteOffset + pos, 4).getUint32(0, true);
    if (pos + 4 + len > all.byteLength) break;
    const payload = all.subarray(pos + 4, pos + 4 + len);
    frames.push(JSON.parse(new TextDecoder().decode(payload)) as T);
    pos += 4 + len;
  }
  return frames;
}

function buildStream(inboundFrames: Uint8Array[]): FakeStream {
  const outFrames: CapturedFrame[] = [];
  let i = 0;
  const stream: FakeStream = {
    outFrames,
    send(b: Uint8Array): boolean {
      outFrames.push({ bytes: new Uint8Array(b) });
      return true;
    },
    closeWriteCalled: 0,
    async closeWrite(): Promise<void> {
      stream.closeWriteCalled++;
    },
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (i >= inboundFrames.length) {
            return { value: undefined as any, done: true };
          }
          return { value: inboundFrames[i++], done: false };
        },
      };
    },
  };
  return stream;
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

let tmpDir: string;
let storage: KgShardStorage;
let identity: Identity;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'kg-shard-client-test-'));
  storage = new KgShardStorage(tmpDir);
  identity = generateIdentity(tmpDir, 'test-node');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('KgShardSnapshotClient', () => {
  it('prefers a peer hint over coord when the peer succeeds', async () => {
    const calls: string[] = [];
    const dialer: ISnapshotDialer = {
      dial: jest.fn(async (peerId: string, _proto: string) => {
        calls.push(peerId);
        return buildStream([
          frameBytes(makeRecord(1)),
          frameBytes(makeRecord(2)),
          frameBytes({ done: true, total: 2, servedAtMs: Date.now() } satisfies SnapshotDone),
        ]);
      }),
    };
    const client = new KgShardSnapshotClient(dialer, identity, storage);
    const total = await client.fetch(0, [{ peerId: 'PEER-A', isCoord: false }], 'COORD');
    expect(total).toBe(2);
    expect(calls).toEqual(['PEER-A']); // coord NOT dialed
    const seen: SnapshotRecord[] = [];
    await storage.read(0, (r) => seen.push(r));
    expect(seen.map((r) => r.embeddingId)).toEqual(['emb-1', 'emb-2']);
  });

  it('falls back to coord when the peer dial throws', async () => {
    const calls: string[] = [];
    const dialer: ISnapshotDialer = {
      dial: jest.fn(async (peerId: string) => {
        calls.push(peerId);
        if (peerId === 'PEER-A') throw new Error('connection refused');
        return buildStream([
          frameBytes(makeRecord(1)),
          frameBytes({ done: true, total: 1, servedAtMs: Date.now() }),
        ]);
      }),
    };
    const client = new KgShardSnapshotClient(dialer, identity, storage);
    const total = await client.fetch(0, [{ peerId: 'PEER-A', isCoord: false }], 'COORD');
    expect(total).toBe(1);
    expect(calls).toEqual(['PEER-A', 'COORD']);
  });

  it('falls back to coord when the peer returns NOT_AUTHORIZED', async () => {
    const calls: string[] = [];
    const dialer: ISnapshotDialer = {
      dial: jest.fn(async (peerId: string) => {
        calls.push(peerId);
        if (peerId === 'PEER-A') {
          return buildStream([
            frameBytes({ error: 'NOT_AUTHORIZED' }),
            // No `done` frame — readJsonFramesUntilDone errors out, but the
            // client checks for `error` BEFORE `done` so it aborts cleanly.
          ]);
        }
        return buildStream([
          frameBytes(makeRecord(1)),
          frameBytes({ done: true, total: 1, servedAtMs: Date.now() }),
        ]);
      }),
    };
    const client = new KgShardSnapshotClient(dialer, identity, storage);
    const total = await client.fetch(0, [{ peerId: 'PEER-A', isCoord: false }], 'COORD');
    expect(total).toBe(1);
    expect(calls).toEqual(['PEER-A', 'COORD']);
    // PEER-A failure left no .bin (commit only fires on real done).
    // After COORD success, we have shard-0.bin with 1 record.
    expect(storage.exists(0)).toBe(true);
  });

  it('throws and persists nothing when every candidate fails', async () => {
    const dialer: ISnapshotDialer = {
      dial: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const client = new KgShardSnapshotClient(dialer, identity, storage);
    await expect(
      client.fetch(0, [{ peerId: 'PEER-A', isCoord: false }], 'COORD'),
    ).rejects.toThrow(/all candidates failed/);
    expect(storage.exists(0)).toBe(false);
  });

  it('drops records whose vector dim is not 768 but keeps appending the rest', async () => {
    const dialer: ISnapshotDialer = {
      dial: jest.fn(async () => buildStream([
        frameBytes({ ...makeRecord(1), vector: new Array(384).fill(0.1) }),
        frameBytes(makeRecord(2)),
        frameBytes({ done: true, total: 2, servedAtMs: Date.now() }),
      ])),
    };
    const client = new KgShardSnapshotClient(dialer, identity, storage);
    const total = await client.fetch(0, [], 'COORD');
    expect(total).toBe(1);
    const seen: SnapshotRecord[] = [];
    await storage.read(0, (r) => seen.push(r));
    expect(seen.map((r) => r.embeddingId)).toEqual(['emb-2']);
  });

  it('signs the canonical `req|<shardId>|<publishedAtMs>` payload on every fetch', async () => {
    let captured: SnapshotRequest | null = null;
    const dialer: ISnapshotDialer = {
      dial: jest.fn(async () => {
        const stream = buildStream([
          frameBytes({ done: true, total: 0, servedAtMs: Date.now() }),
        ]);
        // Snoop on the outbound request frame after the client writes.
        const origSend = stream.send.bind(stream);
        stream.send = (b: Uint8Array): boolean => {
          const ok = origSend(b);
          // After the first send, decode the request.
          if (!captured) {
            const out = decodeOutFrames<SnapshotRequest>(stream);
            captured = out[0] ?? null;
          }
          return ok;
        };
        return stream;
      }),
    };
    const client = new KgShardSnapshotClient(dialer, identity, storage);
    await client.fetch(7, [], 'COORD');
    expect(captured).toBeTruthy();
    expect(captured!.shardId).toBe(7);
    expect(captured!.signature).toMatch(/^[0-9a-f]+$/);
    expect(captured!.signature.length).toBe(128); // 64 bytes hex
    expect(typeof captured!.publishedAtMs).toBe('number');
  });

  it('uses the canonical KG_SHARD_SNAPSHOT_PROTOCOL on every dial', async () => {
    const protocols: string[] = [];
    const dialer: ISnapshotDialer = {
      dial: jest.fn(async (_pid, proto) => {
        protocols.push(proto);
        return buildStream([
          frameBytes({ done: true, total: 0, servedAtMs: Date.now() }),
        ]);
      }),
    };
    const client = new KgShardSnapshotClient(dialer, identity, storage);
    await client.fetch(0, [{ peerId: 'P1', isCoord: false }], 'COORD');
    expect(protocols.every((p) => p === KG_SHARD_SNAPSHOT_PROTOCOL)).toBe(true);
  });
});
