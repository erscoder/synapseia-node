/**
 * Plan D.4-distribution.7 — node-side handler for the signed
 * `KG_EMBEDDING_DELTA` gossipsub envelope published by the coord
 * (`KgEmbeddingDeltaPublisher`). Hosts of the matching shard
 * append the records to local storage; the optional `searcher`
 * hook will land the records in HNSW once D.4-hnsw ships.
 *
 * Wire shape mirrors `KgEmbeddingDeltaBody` on the coord side.
 * Body validation rejects:
 *   - shape with missing fields,
 *   - body.shardId mismatch with any record.shardId,
 *   - record.shardId !== shardIdFor(record.embeddingId) — protects
 *     against a hostile coord (or relay) trying to route an
 *     embedding to the wrong host.
 *   - vector.length !== 768 (PubMedBERT only — see audit).
 *
 * Memory `feedback_node_no_db` — disk only via `IKgShardStorage`.
 * Memory `feedback_logger` — project logger; never `console.*`.
 */

import logger from '../../utils/logger';
import {
  type KgShardSignedEnvelope,
  verifyKgShardEnvelope,
} from '../protocols/kg-shard-envelope';
import { shardIdFor } from '../kg-shard/shard-hash';
import type { IKgShardOwnershipStore } from '../kg-shard/KgShardOwnershipStore';
import type { IKgShardStorage, SnapshotRecord } from '../kg-shard/KgShardStorage';

const VECTOR_DIM = 768;

export interface KgEmbeddingDeltaRecord {
  embeddingId: string;
  shardId: number;
  op: 'upsert';
  vector: number[];
  sourceType: string;
  sourceId: string;
  domain: string;
  evidenceLevel: string | null;
  createdAtMs: number;
}

export interface KgEmbeddingDeltaBody extends Record<string, unknown> {
  shardId: number;
  records: KgEmbeddingDeltaRecord[];
  publishedAtMs: number;
}

/** Optional adapter — D.4-hnsw will pass the live HNSW searcher.
 *  In D.4-distribution.7 the field is undefined and the call is a
 *  no-op. */
export interface IKgShardSearcherHook {
  addItem(vec: number[], id: string): void;
}

export interface HandleKgEmbeddingDeltaArgs {
  /** Coord's raw 32-byte Ed25519 pubkey. */
  pubkey: Uint8Array;
  /** Raw gossipsub message bytes. */
  msg: Uint8Array;
  /** In-memory ownership store; only act on shards we currently host. */
  store: IKgShardOwnershipStore;
  /** On-disk shard storage; appendOne extends the existing .bin file. */
  storage: IKgShardStorage;
  /** Optional HNSW hook (D.4-hnsw). */
  searcher?: IKgShardSearcherHook;
  warn?: (msg: string) => void;
  now?: () => number;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseEnvelope(
  msg: Uint8Array,
): KgShardSignedEnvelope<KgEmbeddingDeltaBody> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(msg));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const { body, publishedAt, signedBy, signature } = raw as {
    body?: unknown;
    publishedAt?: unknown;
    signedBy?: unknown;
    signature?: unknown;
  };
  if (!isObject(body)) return null;
  if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt)) return null;
  if (signedBy !== 'coordinator_authority') return null;
  if (typeof signature !== 'string' || signature.length === 0) return null;
  return {
    body: body as KgEmbeddingDeltaBody,
    publishedAt,
    signedBy: 'coordinator_authority',
    signature,
  };
}

function isValidRecord(x: unknown): x is KgEmbeddingDeltaRecord {
  if (!isObject(x)) return false;
  const r = x as Partial<KgEmbeddingDeltaRecord>;
  if (typeof r.embeddingId !== 'string' || r.embeddingId.length === 0) return false;
  if (typeof r.shardId !== 'number' || !Number.isFinite(r.shardId) || r.shardId < 0) return false;
  if (r.op !== 'upsert') return false;
  if (!Array.isArray(r.vector) || r.vector.length !== VECTOR_DIM) return false;
  if (typeof r.sourceType !== 'string') return false;
  if (typeof r.sourceId !== 'string') return false;
  if (typeof r.domain !== 'string') return false;
  if (r.evidenceLevel !== null && typeof r.evidenceLevel !== 'string') return false;
  if (typeof r.createdAtMs !== 'number' || !Number.isFinite(r.createdAtMs)) return false;
  return true;
}

function isValidBody(b: unknown): b is KgEmbeddingDeltaBody {
  if (!isObject(b)) return false;
  const body = b as Partial<KgEmbeddingDeltaBody>;
  if (typeof body.shardId !== 'number' || !Number.isFinite(body.shardId) || body.shardId < 0) return false;
  if (typeof body.publishedAtMs !== 'number' || !Number.isFinite(body.publishedAtMs)) return false;
  if (!Array.isArray(body.records) || body.records.length === 0) return false;
  for (const r of body.records) {
    if (!isValidRecord(r)) return false;
    if (r.shardId !== body.shardId) return false;
    if (r.shardId !== shardIdFor(r.embeddingId)) return false;
  }
  return true;
}

export async function handleKgEmbeddingDelta(
  args: HandleKgEmbeddingDeltaArgs,
): Promise<void> {
  const warn = args.warn ?? ((m: string) => logger.warn(m));
  const now = args.now ?? Date.now;

  const envelope = parseEnvelope(args.msg);
  if (!envelope) {
    warn('[kg-delta] invalid envelope shape');
    return;
  }

  const verdict = verifyKgShardEnvelope(envelope, args.pubkey, { now });
  if (!verdict.valid) {
    warn(`[kg-delta] envelope rejected: ${verdict.reason ?? 'unknown'}`);
    return;
  }

  if (!isValidBody(envelope.body)) {
    warn('[kg-delta] envelope body invalid (shape, dim, or shardId mismatch)');
    return;
  }

  const { shardId, records } = envelope.body;
  if (!args.store.has(shardId)) {
    // We don't host this shard — the topic is global, so it's normal
    // to see envelopes for shards we don't own. Skip silently.
    return;
  }

  // Reviewer item #7 — single open/write/close per batch instead of
  // per-record. The handler already validated every record's vector
  // dim + shardId parity above, so a partial-write failure here is
  // an actual disk fault and abort-on-fail is the right behaviour
  // (we re-emit on the next delta cycle once disk recovers).
  const asSnapshots: SnapshotRecord[] = records.map((r) => ({
    embeddingId: r.embeddingId,
    shardId: r.shardId,
    vector: r.vector,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    domain: r.domain,
    evidenceLevel: r.evidenceLevel,
    createdAtMs: r.createdAtMs,
  }));
  let applied = 0;
  try {
    await args.storage.appendMany(shardId, asSnapshots);
    applied = records.length;
  } catch (err) {
    warn(
      `[kg-delta] storage appendMany failed shard=${shardId} records=${records.length}: ${(err as Error).message}`,
    );
    return;
  }

  // Searcher hook is per-record because HNSW APIs are id-keyed —
  // no batched insert.
  let searcherFailed = 0;
  for (const r of records) {
    try {
      args.searcher?.addItem(r.vector, r.embeddingId);
    } catch (err) {
      searcherFailed++;
      warn(
        `[kg-delta] searcher hook failed shard=${shardId} embeddingId=${r.embeddingId}: ${(err as Error).message}`,
      );
    }
  }

  logger.log(
    `[kg-delta] applied shard=${shardId} records=${applied}` +
      (searcherFailed > 0 ? ` searcherFailed=${searcherFailed}` : ''),
  );
}
