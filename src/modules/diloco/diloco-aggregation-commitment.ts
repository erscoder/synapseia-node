/**
 * Commit-reveal commitment computation for DiLoCo node-side aggregation
 * (re-architecture Phase 3). This is a FAITHFUL replica of the coord's
 * `aggregationInvariantEnvelope` + `computeCommitment` +
 * `canonicalJSON` / `sha256OfCanonicalPayload`
 * (`packages/coordinator/src/domain/entities/DiLoCoAggregationResult.ts`
 * + `LoraValidationResult.ts`).
 *
 * The coord recomputes the commitment on REVEAL and rejects on mismatch
 * (`DiLoCoController.aggregationResult`). A single byte of drift — key
 * order, whitespace, number formatting, set sort — breaks the
 * commit-reveal and the node's reveal is rejected with HTTP 403. So this
 * file MUST stay byte-identical to the coord pipeline; the cross-check
 * test (`diloco-aggregation-commitment.spec.ts`) asserts equality against
 * the literal coord algorithm.
 *
 * commitment = sha256( canonicalJSON({ envelope: canonicalJSON(invariantEnvelope), nonce }) )
 *
 * NOTE the TWO-LAYER pipeline (matching the coord exactly):
 *   1. inner  = canonicalJSON(aggregationInvariantEnvelope(invariants))  → string
 *   2. outer  = canonicalJSON({ envelope: <inner-string>, nonce })       → string
 *   3. commit = sha256Hex(outer)
 * The inner canonical-JSON is embedded as a STRING value in the outer
 * object (NOT re-parsed), exactly as `sha256OfCanonicalPayload({ envelope:
 * canonicalJSON(envelope), nonce })` does on the coord.
 */
import { createHash } from 'crypto';

/** A single rejected-peer record. Mirrors the coord's `DiLoCoRejectedPeer`. */
export interface DiLoCoRejectedPeer {
  readonly peerId: string;
  /** `cosine_low` | `cosine_nan` | … (node filter taxonomy). */
  readonly reason: string;
}

/** Canonical aggregation invariants — the consensus key (coord §4.1). */
export interface DiLoCoAggregationInvariants {
  readonly avgGradientNorm: number;
  readonly velocityNorm: number;
  readonly acceptedPeerIds: readonly string[];
  readonly rejectedPeerIds: readonly DiLoCoRejectedPeer[];
  readonly adapterSha256: string;
  /**
   * Per-peer cosine-to-consensus the aggregator script emits (phase 2 —
   * carry the alignment signal under the commitment so a later
   * blend-ranking phase can read it trustlessly). Map peerId → cosine
   * float, or the literal STRING `"NaN"` for an undefined cosine (the
   * Python script emits `"NaN"`, not JS NaN). DARK after this phase:
   * nothing CONSUMES it yet.
   *
   * BACKWARD-COMPAT (critical): OPTIONAL. When `undefined` (old
   * aggregators that do not send it) the {@link aggregationInvariantEnvelope}
   * OMITS the key entirely, making the envelope byte-identical to the
   * pre-change shape — old reveals verify against the golden hash exactly
   * as before. Only present when the aggregator threads it through.
   */
  readonly perPeerCosine?: Readonly<Record<string, number | 'NaN'>>;
}

/**
 * Recursive canonical JSON — byte-identical to the coord's `canonicalJSON`
 * in `LoraValidationResult.ts`:
 *   - primitives via `JSON.stringify`
 *   - arrays preserve order, recursively canonicalised
 *   - objects: keys sorted ascending, no whitespace
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
  return `{${entries.join(',')}}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build the canonical invariant envelope. Sets are SORTED so two
 * aggregators that filter the same peers in a different order still
 * produce a byte-identical envelope. Mirrors the coord's
 * `aggregationInvariantEnvelope` exactly:
 *   - `acceptedPeerIds`: sorted ascending (default lexicographic).
 *   - `rejectedPeerIds`: sorted ascending by `peerId`, each entry kept as
 *     `{ peerId, reason }`.
 */
export function aggregationInvariantEnvelope(invariants: DiLoCoAggregationInvariants): {
  avgGradientNorm: number;
  velocityNorm: number;
  acceptedPeerIds: string[];
  rejectedPeerIds: DiLoCoRejectedPeer[];
  adapterSha256: string;
  perPeerCosine?: Record<string, number | 'NaN'>;
} {
  const acceptedPeerIds = [...invariants.acceptedPeerIds].sort();
  const rejectedPeerIds = [...invariants.rejectedPeerIds]
    .map((r) => ({ peerId: r.peerId, reason: r.reason }))
    .sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
  const envelope: {
    avgGradientNorm: number;
    velocityNorm: number;
    acceptedPeerIds: string[];
    rejectedPeerIds: DiLoCoRejectedPeer[];
    adapterSha256: string;
    perPeerCosine?: Record<string, number | 'NaN'>;
  } = {
    avgGradientNorm: invariants.avgGradientNorm,
    velocityNorm: invariants.velocityNorm,
    acceptedPeerIds,
    rejectedPeerIds,
    adapterSha256: invariants.adapterSha256,
  };
  // BACKWARD-COMPAT seam: only ADD the key when present. `canonicalJSON`
  // sorts object keys recursively, so a key-sorted plain copy here is
  // already byte-deterministic; we sort the peerId keys explicitly to
  // mirror the `acceptedPeerIds.sort()` discipline (and so the shape is
  // independent of insertion order). The `"NaN"` STRING value passes
  // straight through `JSON.stringify` as `"NaN"`. When `perPeerCosine`
  // is undefined the key is omitted entirely → the envelope (and thus
  // the commitment) is byte-identical to the pre-phase-2 shape.
  if (invariants.perPeerCosine !== undefined) {
    envelope.perPeerCosine = sortCosineKeys(invariants.perPeerCosine);
  }
  return envelope;
}

/**
 * Return a NEW plain object with the peerId keys sorted ascending. Values
 * (cosine float or the `"NaN"` string) are copied verbatim. Deterministic
 * regardless of the source map's insertion order — mirrors the
 * coord-side mirror so both pipelines build a byte-identical envelope.
 */
function sortCosineKeys(
  perPeerCosine: Readonly<Record<string, number | 'NaN'>>,
): Record<string, number | 'NaN'> {
  const out: Record<string, number | 'NaN'> = {};
  for (const peerId of Object.keys(perPeerCosine).sort()) {
    out[peerId] = perPeerCosine[peerId];
  }
  return out;
}

/**
 * Compute the commit-reveal commitment. Byte-identical to the coord's
 * `computeCommitment`:
 *   `sha256OfCanonicalPayload({ envelope: canonicalJSON(envelope), nonce })`.
 * Fails closed on an empty nonce (P2) — an empty-nonce commitment is
 * trivially forgeable by a copier.
 */
export function computeCommitment(invariants: DiLoCoAggregationInvariants, nonce: string): string {
  if (!nonce || nonce.trim().length === 0) {
    throw new Error('computeCommitment: nonce is required');
  }
  const envelope = aggregationInvariantEnvelope(invariants);
  return sha256Hex(canonicalJSON({ envelope: canonicalJSON(envelope), nonce }));
}
