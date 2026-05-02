/**
 * kg-shard-ownership.ts — node-side handler for the signed
 * `KG_SHARD_OWNERSHIP` gossipsub envelope published by the
 * coordinator every time `KgShardAssignmentCronService` writes /
 * renews / revokes a grant.
 *
 * Wire format (Plan D.3 — see
 * `packages/coordinator/src/infrastructure/p2p/kg-shard-envelope.ts`):
 *   {
 *     body:        { peerId, shardId, signature, expiresAt },
 *     publishedAt: unix-ms,
 *     signedBy:    'coordinator_authority',
 *     signature:   hex(Ed25519(canonicalJson({body, publishedAt})))
 *   }
 *
 * Behaviour:
 *   - Verify the envelope against the coord's pubkey. Drop on any
 *     failure (forged sig, stale, malformed).
 *   - Only act when `body.peerId === thisPeerId`. Other peers' grants
 *     are not relevant to a hosting decision on this node — the coord
 *     re-publishes the full snapshot for everyone, but only OUR rows
 *     mutate this store.
 *   - If `body.expiresAt <= now()` treat as revocation: delete the
 *     local entry. Otherwise upsert with the supplied expiry.
 *
 * Plan D.4.
 */
import logger from '../../utils/logger';
import {
  type KgShardSignedEnvelope,
  verifyKgShardEnvelope,
} from '../protocols/kg-shard-envelope';
import type { IKgShardOwnershipStore } from '../kg-shard/KgShardOwnershipStore';

export interface KgShardOwnershipBody extends Record<string, unknown> {
  /** libp2p peerId of the holder (string form). */
  peerId: string;
  /** Shard index `0..N-1`. */
  shardId: number;
  /** Coord-side per-row signature (`Ed25519(<peerId>|<shardId>|<exp>)`).
   *  We don't re-verify this on the node — the envelope signature
   *  already authenticates the coord-emitted body. Carried so future
   *  audit tooling can replay against the SQL row. */
  signature: string;
  /** Unix-ms expiry. */
  expiresAt: number;
}

export interface HandleKgShardOwnershipArgs {
  /** Raw 32-byte coord Ed25519 pubkey (`loadCoordinatorPubkey`). */
  pubkey: Uint8Array;
  /** Raw gossipsub message bytes. */
  msg: Uint8Array;
  /** This node's libp2p peerId — only matching grants update the store. */
  thisPeerId: string;
  /** In-memory ownership store mutated by valid grants. */
  store: IKgShardOwnershipStore;
  /** Override warn sink (defaults to project logger.warn). */
  warn?: (msg: string) => void;
  /** Override clock (ms-epoch). */
  now?: () => number;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseEnvelope(
  msg: Uint8Array,
): KgShardSignedEnvelope<KgShardOwnershipBody> | null {
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
    body: body as KgShardOwnershipBody,
    publishedAt,
    signedBy: 'coordinator_authority',
    signature,
  };
}

function isValidBody(body: unknown): body is KgShardOwnershipBody {
  if (!isObject(body)) return false;
  const { peerId, shardId, signature, expiresAt } = body as {
    peerId?: unknown;
    shardId?: unknown;
    signature?: unknown;
    expiresAt?: unknown;
  };
  if (typeof peerId !== 'string' || peerId.length === 0) return false;
  if (typeof shardId !== 'number' || !Number.isFinite(shardId) || shardId < 0) return false;
  if (typeof signature !== 'string') return false;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return true;
}

export async function handleKgShardOwnership(
  args: HandleKgShardOwnershipArgs,
): Promise<void> {
  const warn = args.warn ?? ((m: string) => logger.warn(m));
  const now = args.now ?? Date.now;

  const envelope = parseEnvelope(args.msg);
  if (!envelope) {
    warn('[KG-Ownership] invalid envelope shape');
    return;
  }

  const verdict = verifyKgShardEnvelope(envelope, args.pubkey, { now });
  if (!verdict.valid) {
    warn(`[KG-Ownership] envelope rejected: ${verdict.reason ?? 'unknown'}`);
    return;
  }

  if (!isValidBody(envelope.body)) {
    warn('[KG-Ownership] envelope body missing required fields');
    return;
  }

  // Only this node's grants matter. Coord publishes the full per-grant
  // stream so other nodes can build their own routing table — but for
  // the local hosting decision we only care about ours.
  if (envelope.body.peerId !== args.thisPeerId) return;

  const { shardId, expiresAt } = envelope.body;
  if (expiresAt <= now()) {
    // Revocation or already-expired grant — drop any local entry.
    args.store.delete(shardId);
    logger.log(`[KG-Ownership] shard ${shardId} revoked / expired (peer matches)`);
    return;
  }

  args.store.set(shardId, expiresAt);
  logger.log(
    `[KG-Ownership] shard ${shardId} authorised until ` +
      `${new Date(expiresAt).toISOString()}`,
  );
}
