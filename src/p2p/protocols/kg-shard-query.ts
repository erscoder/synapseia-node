/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * kg-shard-query.ts — libp2p protocol `/synapseia/kg-shard-query/1.0.0`.
 *
 * Inbound peer-to-peer KG shard query. The requester (peer that received
 * the user-facing `/knowledge-graph/query` HTTP call) opens a stream to
 * the shard host, sends a single JSON request frame, reads back a single
 * JSON response frame. Length-prefixed framing via the existing
 * `stream-codec.ts` so the wire format stays consistent with the chat
 * protocol.
 *
 * Authorisation: the host must currently hold an active
 * `kg_shard_authorizations` grant for `request.shardId` (recorded in
 * `KgShardOwnershipStore` via the gossipsub `KG_SHARD_OWNERSHIP` topic).
 * If the grant has expired (or never existed) we respond with
 * `{ error: 'NOT_AUTHORIZED' }` — this is a contract failure, not a
 * stack trace, so the requester can fall through to its Postgres race
 * fallback (Plan D.5) instead of crashing.
 *
 * D.4 ships the skeleton: ownership check + stub `hits: []` reply. The
 * actual HNSW ANN search is the immediate follow-up — the integration
 * point is marked with `TODO(D.4-followup)`.
 *
 * Plan D.4.
 */
import logger from '../../utils/logger';
import { sendJsonOverStream, readJsonFromStream } from '../../modules/p2p/stream-codec';
import type { IKgShardOwnershipStore } from '../kg-shard/KgShardOwnershipStore';

export const KG_SHARD_QUERY_PROTOCOL = '/synapseia/kg-shard-query/1.0.0';

export interface KgShardQueryRequest {
  shardId: number;
  /** Pre-computed query embedding (cosine-normalised). Pass `null` to
   *  ask the host to embed `query` itself. */
  embedding: number[] | null;
  /** Raw text query — only used when `embedding` is null. */
  query: string | null;
  /** Top-K hits to return. */
  k: number;
}

export interface KgShardQueryHit {
  /** Discovery / publication / claim id. */
  id: string;
  /** Cosine similarity in `[0, 1]`. */
  score: number;
  /** Optional human-readable label — included so the requester can show
   *  results without a follow-up DB lookup when latency matters. */
  title?: string;
}

export interface KgShardQueryResponse {
  ok: true;
  shardId: number;
  hits: KgShardQueryHit[];
}

export interface KgShardQueryErrorResponse {
  ok?: false;
  error: 'NOT_AUTHORIZED' | 'BAD_REQUEST' | 'INTERNAL';
  detail?: string;
}

export type KgShardQueryReply = KgShardQueryResponse | KgShardQueryErrorResponse;

/** Pluggable ANN search hook — the HNSW implementation will plug in here.
 *  Default impl returns an empty hit list so the protocol round-trip
 *  works end-to-end before HNSW lands. */
export interface IKgShardSearcher {
  search(req: KgShardQueryRequest): Promise<KgShardQueryHit[]>;
}

/** Stub searcher — empty hits. Replaced by the HNSW-backed
 *  implementation in the immediate D.4 follow-up. */
export class StubKgShardSearcher implements IKgShardSearcher {
  // TODO(D.4-followup): replace with HNSW ANN search backed by the
  // discoveries / publications local index.
  async search(_req: KgShardQueryRequest): Promise<KgShardQueryHit[]> {
    return [];
  }
}

interface HandlerDeps {
  store: IKgShardOwnershipStore;
  searcher?: IKgShardSearcher;
}

function isValidRequest(x: unknown): x is KgShardQueryRequest {
  if (typeof x !== 'object' || x === null) return false;
  const req = x as Record<string, unknown>;
  if (typeof req.shardId !== 'number' || !Number.isFinite(req.shardId)) return false;
  if (typeof req.k !== 'number' || !Number.isFinite(req.k) || req.k <= 0) return false;
  const hasEmbedding = Array.isArray(req.embedding);
  const hasQuery = typeof req.query === 'string' && (req.query as string).length > 0;
  if (!hasEmbedding && !hasQuery) return false;
  if (hasEmbedding) {
    for (const v of req.embedding as unknown[]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    }
  }
  return true;
}

/**
 * Build the libp2p stream handler. Returns a function suitable for
 * `p2pNode.handleProtocol(KG_SHARD_QUERY_PROTOCOL, handler)`.
 */
export function makeKgShardQueryHandler(
  deps: HandlerDeps,
): (stream: any, connection: any) => Promise<void> {
  const searcher = deps.searcher ?? new StubKgShardSearcher();
  return async function handler(stream: any, _connection: any): Promise<void> {
    try {
      const req = await readJsonFromStream<KgShardQueryRequest>(stream);
      if (!isValidRequest(req)) {
        await sendJsonOverStream(stream, {
          error: 'BAD_REQUEST',
          detail: 'request missing required fields',
        } satisfies KgShardQueryErrorResponse);
        return;
      }

      if (!deps.store.has(req.shardId)) {
        await sendJsonOverStream(stream, {
          error: 'NOT_AUTHORIZED',
          detail: `shard ${req.shardId} not currently held by this peer`,
        } satisfies KgShardQueryErrorResponse);
        return;
      }

      let hits: KgShardQueryHit[];
      try {
        hits = await searcher.search(req);
      } catch (err) {
        logger.warn(
          `[KG-ShardQuery] search threw on shard ${req.shardId}: ${(err as Error).message}`,
        );
        await sendJsonOverStream(stream, {
          error: 'INTERNAL',
          detail: 'searcher failed',
        } satisfies KgShardQueryErrorResponse);
        return;
      }

      const response: KgShardQueryResponse = {
        ok: true,
        shardId: req.shardId,
        hits,
      };
      await sendJsonOverStream(stream, response);
    } catch (err) {
      logger.warn(`[KG-ShardQuery] stream error: ${(err as Error).message}`);
      try {
        await sendJsonOverStream(stream, {
          error: 'INTERNAL',
          detail: (err as Error).message,
        } satisfies KgShardQueryErrorResponse);
      } catch {
        // peer likely gone — give up
      }
    }
  };
}
