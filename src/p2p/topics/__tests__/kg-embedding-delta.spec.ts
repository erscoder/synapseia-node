/**
 * Plan D.4-distribution.7 — node-side delta handler spec. Real
 * Ed25519 signing through the same SPKI-prefix trick the production
 * verifier uses, so a tampered envelope really fails the verify
 * step (not stub-equality).
 */
import { mkdtempSync, rmSync } from 'fs';
import { generateKeyPairSync, sign as nodeSign } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import { canonicalJson } from '../../protocols/kg-shard-envelope';
import { KgShardOwnershipStore } from '../../kg-shard/KgShardOwnershipStore';
import { KgShardStorage, type SnapshotRecord } from '../../kg-shard/KgShardStorage';
import { shardIdFor } from '../../kg-shard/shard-hash';
import {
  handleKgEmbeddingDelta,
  type KgEmbeddingDeltaBody,
  type KgEmbeddingDeltaRecord,
} from '../kg-embedding-delta';

interface KP {
  rawPubkey: Uint8Array;
  sign(payload: Buffer): Buffer;
}

function buildKP(): KP {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPubkey = (spkiDer as Buffer).subarray(spkiDer.byteLength - 32);
  return {
    rawPubkey,
    sign(payload: Buffer): Buffer {
      return nodeSign(null, payload, privateKey);
    },
  };
}

function vec768(seed: number): number[] {
  return new Array(768).fill(0).map((_, i) => (seed + i) * 0.001);
}

function buildBody(shardId: number, recordIds: string[]): KgEmbeddingDeltaBody {
  const records: KgEmbeddingDeltaRecord[] = recordIds.map((id, i) => ({
    embeddingId: id,
    shardId,
    op: 'upsert',
    vector: vec768(i),
    sourceType: 'pubmed',
    sourceId: 'src-' + id,
    domain: 'medical',
    evidenceLevel: null,
    createdAtMs: 1_700_000_000_000 + i,
  }));
  return { shardId, records, publishedAtMs: Date.now() };
}

function buildEnvelopeBytes(kp: KP, body: KgEmbeddingDeltaBody): Uint8Array {
  const publishedAt = Date.now();
  const canonical = canonicalJson({ body, publishedAt });
  const signature = kp.sign(Buffer.from(canonical, 'utf8'));
  const env = {
    body,
    publishedAt,
    signedBy: 'coordinator_authority',
    signature: signature.toString('hex'),
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

/** Find N embeddingIds whose `shardIdFor` lands on `target`. */
function pickIdsForShard(target: number, count: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (out.length < count) {
    const id = `embed-x-${i++}`;
    if (shardIdFor(id) === target) out.push(id);
  }
  return out;
}

describe('handleKgEmbeddingDelta', () => {
  let tmpDir: string;
  let storage: KgShardStorage;
  let store: KgShardOwnershipStore;
  let coordKP: KP;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'kg-delta-handler-test-'));
    storage = new KgShardStorage(tmpDir);
    store = new KgShardOwnershipStore();
    coordKP = buildKP();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends every record to the local shard file when the shard is owned', async () => {
    const SHARD = 4;
    const ids = pickIdsForShard(SHARD, 3);
    store.set(SHARD, Date.now() + 60_000);
    const body = buildBody(SHARD, ids);
    const msg = buildEnvelopeBytes(coordKP, body);
    await handleKgEmbeddingDelta({ pubkey: coordKP.rawPubkey, msg, store, storage });

    const seen: SnapshotRecord[] = [];
    const total = await storage.read(SHARD, (r) => seen.push(r));
    expect(total).toBe(3);
    expect(seen.map((r) => r.embeddingId).sort()).toEqual(ids.slice().sort());
  });

  it('ignores envelopes for shards we do NOT host (no file mutation)', async () => {
    const SHARD = 4;
    const ids = pickIdsForShard(SHARD, 2);
    // store.has(SHARD) === false
    const body = buildBody(SHARD, ids);
    const msg = buildEnvelopeBytes(coordKP, body);
    await handleKgEmbeddingDelta({ pubkey: coordKP.rawPubkey, msg, store, storage });
    expect(storage.exists(SHARD)).toBe(false);
  });

  it('rejects envelopes with a forged signature (different signer)', async () => {
    const SHARD = 4;
    const ids = pickIdsForShard(SHARD, 1);
    store.set(SHARD, Date.now() + 60_000);
    const otherKP = buildKP();
    const body = buildBody(SHARD, ids);
    const msg = buildEnvelopeBytes(otherKP, body); // signed by impostor
    const warns: string[] = [];
    await handleKgEmbeddingDelta({
      pubkey: coordKP.rawPubkey, msg, store, storage,
      warn: (m) => warns.push(m),
    });
    expect(storage.exists(SHARD)).toBe(false);
    expect(warns.some((m) => m.includes('envelope rejected'))).toBe(true);
  });

  it('rejects envelopes where body.shardId !== record.shardId', async () => {
    const SHARD = 4;
    const ids = pickIdsForShard(SHARD, 1);
    store.set(SHARD, Date.now() + 60_000);
    const body = buildBody(SHARD, ids);
    body.records[0].shardId = SHARD + 1; // mismatch
    const msg = buildEnvelopeBytes(coordKP, body);
    const warns: string[] = [];
    await handleKgEmbeddingDelta({
      pubkey: coordKP.rawPubkey, msg, store, storage,
      warn: (m) => warns.push(m),
    });
    expect(storage.exists(SHARD)).toBe(false);
    expect(warns.some((m) => m.includes('body invalid'))).toBe(true);
  });

  it('rejects envelopes where shardId !== shardIdFor(embeddingId) (anti-route-spoof)', async () => {
    const SHARD = 4;
    const idForOtherShard = pickIdsForShard((SHARD + 1) % 16, 1)[0];
    store.set(SHARD, Date.now() + 60_000);
    const body = buildBody(SHARD, [idForOtherShard]);
    // Now record.shardId === SHARD but shardIdFor(idForOtherShard) !== SHARD.
    const msg = buildEnvelopeBytes(coordKP, body);
    const warns: string[] = [];
    await handleKgEmbeddingDelta({
      pubkey: coordKP.rawPubkey, msg, store, storage,
      warn: (m) => warns.push(m),
    });
    expect(storage.exists(SHARD)).toBe(false);
    expect(warns.some((m) => m.includes('body invalid'))).toBe(true);
  });

  it('rejects envelopes whose vector dim != 768', async () => {
    const SHARD = 4;
    const ids = pickIdsForShard(SHARD, 1);
    store.set(SHARD, Date.now() + 60_000);
    const body = buildBody(SHARD, ids);
    body.records[0].vector = new Array(384).fill(0.1);
    const msg = buildEnvelopeBytes(coordKP, body);
    const warns: string[] = [];
    await handleKgEmbeddingDelta({
      pubkey: coordKP.rawPubkey, msg, store, storage,
      warn: (m) => warns.push(m),
    });
    expect(storage.exists(SHARD)).toBe(false);
    expect(warns.some((m) => m.includes('body invalid'))).toBe(true);
  });

  it('invokes the optional searcher.addItem for every record', async () => {
    const SHARD = 4;
    const ids = pickIdsForShard(SHARD, 3);
    store.set(SHARD, Date.now() + 60_000);
    const body = buildBody(SHARD, ids);
    const msg = buildEnvelopeBytes(coordKP, body);
    const calls: Array<{ shardId: number; id: string; len: number }> = [];
    const searcher = {
      addItemToShard: (s: number, vec: number[], id: string): void => {
        calls.push({ shardId: s, id, len: vec.length });
      },
    };
    await handleKgEmbeddingDelta({
      pubkey: coordKP.rawPubkey, msg, store, storage, searcher,
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.len === 768)).toBe(true);
    expect(calls.every((c) => c.shardId === SHARD)).toBe(true);
    expect(calls.map((c) => c.id).sort()).toEqual(ids.slice().sort());
  });
});
