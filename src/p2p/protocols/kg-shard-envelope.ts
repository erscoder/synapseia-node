/**
 * kg-shard-envelope.ts — node-side verifier for the KG-shard signed
 * envelope published on `KG_SHARD_OWNERSHIP` and `KG_QUERY_REDIRECT`.
 *
 * Source-of-truth contract:
 *   `packages/coordinator/src/infrastructure/p2p/kg-shard-envelope.ts`.
 *
 * The two repos publish independently, so we copy the verify path here
 * rather than importing across packages. Both sides MUST stay byte-for-
 * byte identical — same canonical JSON, same SPKI prefix, same skew
 * window. If either copy changes, sync the other.
 *
 * Plan D.4.
 */
import { createPublicKey, verify as nodeVerify } from 'crypto';

/** Wire shape produced by the coord-side `signKgShardEnvelope` and
 *  consumed here. Mirror of `KgShardSignedEnvelope` in
 *  `packages/coordinator/.../P2PBootstrapService.ts`. */
export interface KgShardSignedEnvelope<TBody = Record<string, unknown>> {
  body: TBody;
  signedBy: 'coordinator_authority';
  signature: string;
  /** Unix ms — verifier rejects envelopes too far in the future or older
   *  than `KG_SHARD_ENVELOPE_MAX_AGE_MS`. */
  publishedAt: number;
}

/** ASN.1 DER prefix for Ed25519 SubjectPublicKeyInfo (SPKI). Same trick
 *  the existing `verify-ed25519.ts` helper uses. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Maximum age of an envelope the verifier accepts. Two minutes is
 *  enough to absorb gossipsub diffusion + clock skew without leaving a
 *  long replay window for revoked grants. */
export const KG_SHARD_ENVELOPE_MAX_AGE_MS = 2 * 60 * 1000;

/** Tolerated future-skew. Coord's clock can be at most 5 s ahead of the
 *  node's wall clock before we reject. */
export const KG_SHARD_ENVELOPE_FUTURE_SKEW_MS = 5_000;

/** JSON.stringify with sorted keys at every level. The coord-side
 *  signer uses the same routine so the byte payload that goes into
 *  Ed25519 is identical on both ends. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]),
  );
  return '{' + parts.join(',') + '}';
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify a signed KG-shard envelope against the coordinator's raw
 * 32-byte Ed25519 public key.
 */
export function verifyKgShardEnvelope<T extends Record<string, unknown>>(
  envelope: KgShardSignedEnvelope<T>,
  coordinatorPublicKey: Uint8Array,
  options: { now?: () => number; maxAgeMs?: number; futureSkewMs?: number } = {},
): VerifyResult {
  if (envelope.signedBy !== 'coordinator_authority') {
    return { valid: false, reason: 'signedBy != coordinator_authority' };
  }
  const now = options.now?.() ?? Date.now();
  const maxAge = options.maxAgeMs ?? KG_SHARD_ENVELOPE_MAX_AGE_MS;
  const futureSkew = options.futureSkewMs ?? KG_SHARD_ENVELOPE_FUTURE_SKEW_MS;
  if (
    typeof envelope.publishedAt !== 'number' ||
    !Number.isFinite(envelope.publishedAt) ||
    envelope.publishedAt > now + futureSkew ||
    envelope.publishedAt < now - maxAge
  ) {
    return { valid: false, reason: 'publishedAt out of bounds' };
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(envelope.signature);
  } catch {
    return { valid: false, reason: 'malformed signature hex' };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, reason: 'signature length != 64 bytes' };
  }
  const canonical = canonicalJson({
    body: envelope.body,
    publishedAt: envelope.publishedAt,
  });
  const payload = Buffer.from(canonical, 'utf8');
  try {
    const spki = Buffer.concat([
      ED25519_SPKI_PREFIX,
      Buffer.from(coordinatorPublicKey),
    ]);
    const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const ok = nodeVerify(null, payload, keyObj, Buffer.from(sigBytes));
    return ok
      ? { valid: true }
      : { valid: false, reason: 'ed25519 verify returned false' };
  } catch (err) {
    return {
      valid: false,
      reason: `ed25519 verify threw: ${(err as Error).message}`,
    };
  }
}

function hexToBytes(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length % 2 !== 0) {
    throw new Error('odd-length hex');
  }
  return Uint8Array.from(Buffer.from(s, 'hex'));
}
