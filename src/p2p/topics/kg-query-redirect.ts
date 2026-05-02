/**
 * kg-query-redirect.ts — node-side handler for the signed
 * `KG_QUERY_REDIRECT` gossipsub envelope.
 *
 * Plan D.5 will publish from the coord whenever a `/knowledge-graph/query`
 * HTTP request maps to a shard NOT hosted by the coord. Every peer
 * subscribed to the topic verifies the envelope; only peers that
 * currently own `body.shardId` (per `KgShardOwnershipStore`) act on it
 * and dial back the requester directly over
 * `/synapseia/kg-shard-query/1.0.0`.
 *
 * Wire format (Plan D.3 — `kg-shard-envelope.ts`):
 *   {
 *     body: {
 *       shardId, requesterPeerId, queryId,
 *       query, embedding, k
 *     },
 *     publishedAt, signedBy: 'coordinator_authority', signature
 *   }
 *
 * If the dial fails we log a warn and drop — the coord's race fallback
 * (Postgres) will satisfy the requester even if every authorised peer
 * misses the redirect.
 *
 * Plan D.4.
 */
import logger from '../../utils/logger';
import {
  type KgShardSignedEnvelope,
  verifyKgShardEnvelope,
} from '../protocols/kg-shard-envelope';
import type { IKgShardOwnershipStore } from '../kg-shard/KgShardOwnershipStore';
import type {
  KgShardQueryReply,
  KgShardQueryRequest,
} from '../protocols/kg-shard-query';

export interface KgQueryRedirectBody extends Record<string, unknown> {
  shardId: number;
  requesterPeerId: string;
  queryId: string;
  query: string | null;
  embedding: number[] | null;
  k: number;
}

/** Abstraction over `libp2p.dialProtocol` so this handler is
 *  unit-testable without spinning up a real libp2p instance. The wiring
 *  in `node-runtime.ts` provides an adapter that uses
 *  `P2PNode.getNode().dialProtocol(...)` + the existing `stream-codec`
 *  for the request/response framing. */
export interface IKgQueryDialer {
  /** Dial `peerId` on `/synapseia/kg-shard-query/1.0.0`, send `request`,
   *  await one reply, then close. Throws on dial / write / parse error. */
  query(peerId: string, request: KgShardQueryRequest): Promise<KgShardQueryReply>;
}

export interface HandleKgQueryRedirectArgs {
  /** Raw 32-byte coord Ed25519 pubkey. */
  pubkey: Uint8Array;
  /** Raw gossipsub message bytes. */
  msg: Uint8Array;
  /** This node's libp2p peerId — used to short-circuit self-dials. */
  thisPeerId: string;
  /** In-memory ownership store. Only act on shards we currently own. */
  store: IKgShardOwnershipStore;
  /** Adapter that knows how to open a stream and send a request frame. */
  dialer: IKgQueryDialer;
  /** Override warn sink. */
  warn?: (msg: string) => void;
  /** Override clock. */
  now?: () => number;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseEnvelope(
  msg: Uint8Array,
): KgShardSignedEnvelope<KgQueryRedirectBody> | null {
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
    body: body as KgQueryRedirectBody,
    publishedAt,
    signedBy: 'coordinator_authority',
    signature,
  };
}

function isValidBody(body: unknown): body is KgQueryRedirectBody {
  if (!isObject(body)) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.shardId !== 'number' || !Number.isFinite(b.shardId) || b.shardId < 0) return false;
  if (typeof b.requesterPeerId !== 'string' || b.requesterPeerId.length === 0) return false;
  if (typeof b.queryId !== 'string' || b.queryId.length === 0) return false;
  if (typeof b.k !== 'number' || !Number.isFinite(b.k) || b.k <= 0) return false;
  const hasEmbedding = Array.isArray(b.embedding);
  const hasQuery = typeof b.query === 'string' && (b.query as string).length > 0;
  if (!hasEmbedding && !hasQuery) return false;
  return true;
}

export async function handleKgQueryRedirect(
  args: HandleKgQueryRedirectArgs,
): Promise<void> {
  const warn = args.warn ?? ((m: string) => logger.warn(m));
  const now = args.now ?? Date.now;

  const envelope = parseEnvelope(args.msg);
  if (!envelope) {
    warn('[KG-Redirect] invalid envelope shape');
    return;
  }

  const verdict = verifyKgShardEnvelope(envelope, args.pubkey, { now });
  if (!verdict.valid) {
    warn(`[KG-Redirect] envelope rejected: ${verdict.reason ?? 'unknown'}`);
    return;
  }

  if (!isValidBody(envelope.body)) {
    warn('[KG-Redirect] envelope body missing required fields');
    return;
  }

  const body = envelope.body;

  // Silent no-op — every peer subscribed to the topic sees every
  // redirect, but only those holding the shard answer. Logging here
  // would flood gossipsub diffusion logs.
  if (!args.store.has(body.shardId)) return;

  // Don't redirect to ourselves — coord shouldn't ask us, but defensive.
  if (body.requesterPeerId === args.thisPeerId) return;

  const request: KgShardQueryRequest = {
    shardId: body.shardId,
    embedding: body.embedding,
    query: body.query,
    k: body.k,
  };

  try {
    await args.dialer.query(body.requesterPeerId, request);
    logger.log(
      `[KG-Redirect] served shard=${body.shardId} queryId=${body.queryId.slice(0, 8)}… ` +
        `→ peer=${body.requesterPeerId.slice(0, 12)}…`,
    );
  } catch (err) {
    warn(
      `[KG-Redirect] dial to ${body.requesterPeerId.slice(0, 12)}… failed for ` +
        `shard=${body.shardId}: ${(err as Error).message} — coord race fallback ` +
        `will satisfy the requester from Postgres`,
    );
  }
}
