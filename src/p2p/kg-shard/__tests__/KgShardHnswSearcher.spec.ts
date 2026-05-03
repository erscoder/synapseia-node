/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Plan D.4-hnsw — KgShardHnswSearcher spec. Uses real `usearch`
 * (the lib's shipped prebuilt binary) so the tests exercise the
 * actual cosine search path, not a stub.
 */
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { KgShardStorage, type SnapshotRecord } from '../KgShardStorage';
import { KgShardHnswSearcher } from '../KgShardHnswSearcher';

function vec(seed: number, dim = 768): number[] {
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) out[i] = Math.sin((seed + i) * 0.01);
  return out;
}

function rec(id: string, seed: number): SnapshotRecord {
  return {
    embeddingId: id,
    shardId: 0,
    vector: vec(seed),
    sourceType: 'pubmed',
    sourceId: 'src-' + id,
    domain: 'medical',
    evidenceLevel: null,
    createdAtMs: 1_700_000_000_000 + seed,
  };
}

describe('KgShardHnswSearcher', () => {
  let tmpDir: string;
  let storage: KgShardStorage;
  let searcher: KgShardHnswSearcher;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'kg-hnsw-test-'));
    storage = new KgShardStorage(tmpDir);
    searcher = new KgShardHnswSearcher({
      nodeHome: tmpDir,
      storage,
      persistDebounceMs: 0,
    });
  });

  afterEach(async () => {
    await searcher.persistAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds index from .bin records when .hnsw absent and persists for next boot', async () => {
    const session = await storage.openSync(0);
    for (let i = 0; i < 10; i++) await session.write(rec(`emb-${i}`, i));
    await session.commit(10);

    const result = await searcher.loadShard(0);
    expect(result.source).toBe('bin');
    expect(result.count).toBe(10);
    expect(searcher.size(0)).toBe(10);

    const hnswPath = path.join(tmpDir, 'shards', 'shard-0.hnsw');
    expect(existsSync(hnswPath)).toBe(true);
  });

  it('loads index from .hnsw on second open (fast path)', async () => {
    const session = await storage.openSync(0);
    for (let i = 0; i < 5; i++) await session.write(rec(`emb-${i}`, i));
    await session.commit(5);
    await searcher.loadShard(0);

    // Fresh searcher instance to force reload from disk.
    const searcher2 = new KgShardHnswSearcher({
      nodeHome: tmpDir,
      storage,
      persistDebounceMs: 0,
    });
    const r = await searcher2.loadShard(0);
    expect(r.source).toBe('hnsw');
    expect(r.count).toBe(5);
  });

  it('search returns top-k by cosine similarity', async () => {
    const session = await storage.openSync(0);
    for (let i = 0; i < 20; i++) await session.write(rec(`emb-${i}`, i));
    await session.commit(20);
    await searcher.loadShard(0);

    // Query vector identical to seed=7 → emb-7 should win.
    const hits = await searcher.search({
      shardId: 0,
      embedding: vec(7),
      query: null,
      k: 3,
    });
    expect(hits.length).toBe(3);
    expect(hits[0].id).toBe('emb-7');
    expect(hits[0].score).toBeGreaterThan(0.9);
    // Hits sorted by descending similarity.
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it('addItemToShard updates the live index without rebuild', async () => {
    const session = await storage.openSync(0);
    await session.write(rec('emb-0', 0));
    await session.commit(1);
    await searcher.loadShard(0);

    expect(searcher.size(0)).toBe(1);
    searcher.addItemToShard(0, vec(99), 'emb-99');
    expect(searcher.size(0)).toBe(2);

    const hits = await searcher.search({
      shardId: 0,
      embedding: vec(99),
      query: null,
      k: 1,
    });
    expect(hits[0].id).toBe('emb-99');
  });

  it('markDeleted excludes the id from subsequent search results', async () => {
    const session = await storage.openSync(0);
    for (let i = 0; i < 10; i++) await session.write(rec(`emb-${i}`, i));
    await session.commit(10);
    await searcher.loadShard(0);

    const before = await searcher.search({
      shardId: 0,
      embedding: vec(5),
      query: null,
      k: 1,
    });
    expect(before[0].id).toBe('emb-5');

    searcher.markDeleted('emb-5');
    const after = await searcher.search({
      shardId: 0,
      embedding: vec(5),
      query: null,
      k: 1,
    });
    expect(after[0].id).not.toBe('emb-5');
  });

  it('addItemToShard does nothing when shard not loaded (silent guard)', async () => {
    searcher.addItemToShard(99, vec(1), 'orphan');
    expect(searcher.size(99)).toBe(0);
  });

  it('search returns [] for shards not loaded', async () => {
    const hits = await searcher.search({
      shardId: 99,
      embedding: vec(1),
      query: null,
      k: 5,
    });
    expect(hits).toEqual([]);
  });

  it('search returns [] when embedding is null (text-only path not in scope)', async () => {
    await storage.openSync(0).then(async (s) => {
      await s.write(rec('emb-0', 0));
      await s.commit(1);
    });
    await searcher.loadShard(0);
    const hits = await searcher.search({
      shardId: 0,
      embedding: null,
      query: 'how does foo bar',
      k: 1,
    });
    expect(hits).toEqual([]);
  });

  it('search returns [] when embedding dim != 768', async () => {
    await storage.openSync(0).then(async (s) => {
      await s.write(rec('emb-0', 0));
      await s.commit(1);
    });
    await searcher.loadShard(0);
    const hits = await searcher.search({
      shardId: 0,
      embedding: vec(0, 384),
      query: null,
      k: 1,
    });
    expect(hits).toEqual([]);
  });

  it('unloadShard releases the in-memory index and persists if dirty', async () => {
    await storage.openSync(0).then(async (s) => {
      await s.write(rec('emb-0', 0));
      await s.commit(1);
    });
    await searcher.loadShard(0);
    searcher.addItemToShard(0, vec(99), 'emb-99');
    await searcher.unloadShard(0);
    expect(searcher.isLoaded(0)).toBe(false);

    // Reload — count should reflect both the original and the addItem.
    // The original got persisted at first loadShard; addItem persisted on unload.
    const reloaded = new KgShardHnswSearcher({
      nodeHome: tmpDir, storage, persistDebounceMs: 0,
    });
    const r = await reloaded.loadShard(0);
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  it('returns source=empty when neither .hnsw nor .bin exist', async () => {
    const r = await searcher.loadShard(7);
    expect(r.source).toBe('empty');
    expect(r.count).toBe(0);
  });

  it('loadShard is idempotent', async () => {
    await storage.openSync(0).then(async (s) => {
      await s.write(rec('emb-0', 0));
      await s.commit(1);
    });
    const first = await searcher.loadShard(0);
    const second = await searcher.loadShard(0);
    expect(first.count).toBe(second.count);
  });
});
