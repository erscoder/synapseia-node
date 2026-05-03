/**
 * Plan D.4-distribution.5 — node-side handler + producer for the
 * `KG_SHARD_SNAPSHOT_READY` gossipsub topic.
 *
 * Difference vs `KG_SHARD_OWNERSHIP`: this envelope is signed by the
 * NODE itself, not coord. The coord pubkey is hardcoded on every
 * node (memory `project_trust_model`) — but node pubkeys are
 * per-peer, so the envelope MUST carry the announcer's full 32-byte
 * Ed25519 pubkey hex. Verifier asserts:
 *   1. `pubkeyHex.length === 64` (32 bytes hex).
 *   2. `pubkeyHex.startsWith(body.peerId)` — `peerId` is derived as
 *      the first 32 hex chars of the publicKey (per `identity.ts:54`).
 *   3. Ed25519 over `canonicalJson({body, publishedAt})` verifies
 *      against the decoded pubkey.
 *
 * Wire shape:
 *   {
 *     body: { peerId, pubkeyHex, shardId, recordsHeld, publishedAtMs },
 *     publishedAt: unix-ms,
 *     signedBy:    'node_self',
 *     signature:   hex(Ed25519(canonicalJson({body, publishedAt})))
 *   }
 *
 * Memory `feedback_logger`: project logger only.
 */

import { createPublicKey, verify as nodeVerify } from 'crypto';
import logger from '../../utils/logger';
import { canonicalJson } from '../protocols/kg-shard-envelope';
import { sign as ed25519Sign } from '../../modules/identity/identity';
import type { Identity } from '../../modules/identity/identity';
import type { IKgShardHintStore } from '../kg-shard/KgShardHintStore';

const KG_SHARD_ENVELOPE_MAX_AGE_MS = 2 * 60 * 1000;
const KG_SHARD_ENVELOPE_FUTURE_SKEW_MS = 5_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface ShardReadyBody extends Record<string, unknown> {
  peerId: string;
  pubkeyHex: string;
  shardId: number;
  recordsHeld: number;
  publishedAtMs: number;
}

export interface ShardReadySignedEnvelope {
  body: ShardReadyBody;
  publishedAt: number;
  signedBy: 'node_self';
  signature: string;
}

export interface HandleShardReadyArgs {
  msg: Uint8Array;
  hints: IKgShardHintStore;
  /** This node's own peerId — used to short-circuit our own announces. */
  thisPeerId: string;
  warn?: (msg: string) => void;
  now?: () => number;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseEnvelope(msg: Uint8Array): ShardReadySignedEnvelope | null {
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
  if (signedBy !== 'node_self') return null;
  if (typeof signature !== 'string' || signature.length === 0) return null;
  return {
    body: body as ShardReadyBody,
    publishedAt,
    signedBy: 'node_self',
    signature,
  };
}

function isValidBody(b: unknown): b is ShardReadyBody {
  if (!isObject(b)) return false;
  const { peerId, pubkeyHex, shardId, recordsHeld, publishedAtMs } = b as {
    peerId?: unknown;
    pubkeyHex?: unknown;
    shardId?: unknown;
    recordsHeld?: unknown;
    publishedAtMs?: unknown;
  };
  if (typeof peerId !== 'string' || peerId.length === 0) return false;
  if (typeof pubkeyHex !== 'string' || pubkeyHex.length !== 64) return false;
  if (!/^[0-9a-f]+$/i.test(pubkeyHex)) return false;
  if (typeof shardId !== 'number' || !Number.isFinite(shardId) || shardId < 0) return false;
  if (typeof recordsHeld !== 'number' || !Number.isFinite(recordsHeld) || recordsHeld < 0) return false;
  if (typeof publishedAtMs !== 'number' || !Number.isFinite(publishedAtMs)) return false;
  return true;
}

export async function handleKgShardSnapshotReady(
  args: HandleShardReadyArgs,
): Promise<void> {
  const warn = args.warn ?? ((m: string) => logger.warn(m));
  const now = args.now ?? Date.now;

  const envelope = parseEnvelope(args.msg);
  if (!envelope) {
    warn('[KG-ShardReady] invalid envelope shape');
    return;
  }

  // Freshness gate (mirrors verifyKgShardEnvelope).
  const t = now();
  if (
    envelope.publishedAt > t + KG_SHARD_ENVELOPE_FUTURE_SKEW_MS ||
    envelope.publishedAt < t - KG_SHARD_ENVELOPE_MAX_AGE_MS
  ) {
    warn(`[KG-ShardReady] envelope rejected: publishedAt out of bounds`);
    return;
  }

  if (!isValidBody(envelope.body)) {
    warn('[KG-ShardReady] envelope body missing required fields');
    return;
  }

  // peerId MUST derive from the announced pubkey (anti-spoof).
  if (!envelope.body.pubkeyHex.toLowerCase().startsWith(envelope.body.peerId.toLowerCase())) {
    warn('[KG-ShardReady] envelope rejected: pubkey/peerId mismatch');
    return;
  }

  // Ignore our OWN announces — we already know we have the shard.
  if (envelope.body.peerId === args.thisPeerId) return;

  // Verify the signature.
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(envelope.signature, 'hex');
  } catch {
    warn('[KG-ShardReady] envelope rejected: malformed signature hex');
    return;
  }
  if (sigBytes.length !== 64) {
    warn('[KG-ShardReady] envelope rejected: signature length != 64');
    return;
  }

  const canonical = canonicalJson({ body: envelope.body, publishedAt: envelope.publishedAt });
  const payload = Buffer.from(canonical, 'utf8');
  const pubkeyBytes = Buffer.from(envelope.body.pubkeyHex, 'hex');
  let verified = false;
  try {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, pubkeyBytes]);
    const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    verified = nodeVerify(null, payload, keyObj, sigBytes);
  } catch {
    verified = false;
  }
  if (!verified) {
    warn('[KG-ShardReady] envelope rejected: ed25519 verify failed');
    return;
  }

  args.hints.add(envelope.body.shardId, envelope.body.peerId);
  logger.log(
    `[KG-ShardReady] hint added shard=${envelope.body.shardId} peer=${envelope.body.peerId.slice(0, 12)} records=${envelope.body.recordsHeld}`,
  );
}

export interface PublishShardReadyDeps {
  identity: Identity;
  shardId: number;
  recordsHeld: number;
  /** Inject a publish function so the spec doesn't need libp2p.
   *  In prod node-runtime wires this to `p2pNode.publish(TOPICS.KG_SHARD_SNAPSHOT_READY, ...)`. */
  publish: (topic: string, payload: Record<string, unknown>) => Promise<void>;
  topic: string;
  now?: () => number;
}

export async function publishShardReady(deps: PublishShardReadyDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const publishedAt = now();
  const body: ShardReadyBody = {
    peerId: deps.identity.peerId,
    pubkeyHex: deps.identity.publicKey,
    shardId: deps.shardId,
    recordsHeld: deps.recordsHeld,
    publishedAtMs: publishedAt,
  };
  const canonical = canonicalJson({ body, publishedAt });
  const signature = await ed25519Sign(canonical, deps.identity.privateKey);
  const envelope: ShardReadySignedEnvelope = {
    body,
    publishedAt,
    signedBy: 'node_self',
    signature,
  };
  await deps.publish(deps.topic, envelope as unknown as Record<string, unknown>);
  logger.log(
    `[KG-ShardReady] published shard=${deps.shardId} records=${deps.recordsHeld}`,
  );
}
