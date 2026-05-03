/**
 * Plan D.4-distribution.4 — node-side append-only storage spec. Each
 * test gets a fresh tempdir under `os.tmpdir()/kg-shard-storage-test-<rnd>`
 * so the on-disk side-effects can't leak between runs.
 */
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { KgShardStorage, type SnapshotRecord } from '../KgShardStorage';

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

describe('KgShardStorage', () => {
  let tmpDir: string;
  let storage: KgShardStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'kg-shard-storage-test-'));
    storage = new KgShardStorage(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a fresh shard via openSync + commit, then reads back the same records', async () => {
    const session = await storage.openSync(0);
    await session.write(makeRecord(1));
    await session.write(makeRecord(2));
    await session.write(makeRecord(3));
    await session.commit(3);

    expect(storage.exists(0)).toBe(true);
    const seen: SnapshotRecord[] = [];
    const total = await storage.read(0, (r) => seen.push(r));
    expect(total).toBe(3);
    expect(seen.map((r) => r.embeddingId)).toEqual(['emb-1', 'emb-2', 'emb-3']);
    // Vector is preserved bit-for-bit.
    expect(seen[0].vector).toHaveLength(768);
    expect(seen[1].vector[0]).toBeCloseTo(2 * 0.001, 10);
  });

  it('does NOT publish records before commit (atomic rename)', async () => {
    const session = await storage.openSync(0);
    await session.write(makeRecord(1));
    expect(storage.exists(0)).toBe(false);
    expect(existsSync(path.join(tmpDir, 'shards', 'shard-0.bin.tmp'))).toBe(true);
    await session.commit(1);
    expect(storage.exists(0)).toBe(true);
    expect(existsSync(path.join(tmpDir, 'shards', 'shard-0.bin.tmp'))).toBe(false);
  });

  it('abort discards the temp file and leaves no .bin', async () => {
    const session = await storage.openSync(0);
    await session.write(makeRecord(1));
    await session.write(makeRecord(2));
    await session.abort();
    expect(storage.exists(0)).toBe(false);
    expect(existsSync(path.join(tmpDir, 'shards', 'shard-0.bin.tmp'))).toBe(false);
  });

  it('drops a stale .tmp from a previous crashed sync on next openSync', async () => {
    const stale = path.join(tmpDir, 'shards', 'shard-0.bin.tmp');
    require('fs').mkdirSync(path.dirname(stale), { recursive: true });
    require('fs').writeFileSync(stale, Buffer.from('garbage'));
    expect(existsSync(stale)).toBe(true);
    const session = await storage.openSync(0);
    await session.write(makeRecord(1));
    await session.commit(1);
    expect(storage.exists(0)).toBe(true);
    const count = await storage.count(0);
    expect(count).toBe(1);
  });

  it('appendOne extends an existing committed shard file', async () => {
    const session = await storage.openSync(0);
    await session.write(makeRecord(1));
    await session.write(makeRecord(2));
    await session.commit(2);
    await storage.appendOne(0, makeRecord(3));
    const seen: SnapshotRecord[] = [];
    const total = await storage.read(0, (r) => seen.push(r));
    expect(total).toBe(3);
    expect(seen.map((r) => r.embeddingId)).toEqual(['emb-1', 'emb-2', 'emb-3']);
  });

  it('count returns 0 for a shard with no .bin file', async () => {
    expect(storage.exists(7)).toBe(false);
    expect(await storage.count(7)).toBe(0);
  });

  it('throws on records that exceed the 1 MB frame cap', async () => {
    const session = await storage.openSync(0);
    const giant = {
      ...makeRecord(99),
      sourceId: 'x'.repeat((1 << 20) + 1),
    };
    await expect(session.write(giant)).rejects.toThrow(/record size/);
    await session.abort();
  });

  it('warns on a partial trailing frame (mid-write crash recovery)', async () => {
    // Build a valid frame followed by a malformed length header pointing
    // beyond EOF, simulating a crash mid-write.
    const session = await storage.openSync(0);
    await session.write(makeRecord(1));
    await session.commit(1);

    const file = storage.pathFor(0);
    const tail = Buffer.alloc(4);
    // Length within the 1 MB cap but pointing past the end of file —
    // simulates a header-only crash mid-write (length got fsync'd, body
    // didn't).
    tail.writeUInt32LE(500, 0);
    require('fs').appendFileSync(file, tail);

    let count = 0;
    const seen = await storage.read(0, () => { count++; });
    expect(seen).toBe(1);
    expect(count).toBe(1);
    expect(statSync(file).size).toBeGreaterThan(0);
  });
});
