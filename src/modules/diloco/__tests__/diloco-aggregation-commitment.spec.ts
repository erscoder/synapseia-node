/**
 * Cross-check: the node's commitment pipeline MUST be byte-identical to
 * the coordinator's. A single byte of drift breaks commit-reveal and the
 * coord rejects the node's reveal with HTTP 403.
 *
 * This test re-implements the coord's EXACT algorithm inline (the literal
 * `aggregationInvariantEnvelope` + `sha256OfCanonicalPayload({ envelope:
 * canonicalJSON(envelope), nonce })` from
 * `coordinator/src/domain/entities/DiLoCoAggregationResult.ts` +
 * `LoraValidationResult.ts`) and asserts our module produces the identical
 * commitment hash. If the coord ever changes its canonical-JSON or
 * envelope shape, this test fails — exactly the early-warning we want.
 */
import { createHash } from 'crypto';
import {
  aggregationInvariantEnvelope,
  computeCommitment,
  canonicalJSON,
  type DiLoCoAggregationInvariants,
} from '../diloco-aggregation-commitment';

// ── Literal coord replica (copied verbatim from coord source) ───────────────

function coordCanonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(coordCanonicalJSON).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${coordCanonicalJSON(obj[k])}`);
  return `{${entries.join(',')}}`;
}
function coordSha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function coordSha256OfCanonicalPayload(payloadJson: Record<string, unknown>): string {
  return coordSha256Hex(coordCanonicalJSON(payloadJson));
}
function coordEnvelope(inv: DiLoCoAggregationInvariants) {
  const acceptedPeerIds = [...inv.acceptedPeerIds].sort();
  const rejectedPeerIds = [...inv.rejectedPeerIds]
    .map((r) => ({ peerId: r.peerId, reason: r.reason }))
    .sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
  return {
    avgGradientNorm: inv.avgGradientNorm,
    velocityNorm: inv.velocityNorm,
    acceptedPeerIds,
    rejectedPeerIds,
    adapterSha256: inv.adapterSha256,
  };
}
function coordComputeCommitment(inv: DiLoCoAggregationInvariants, nonce: string): string {
  const envelope = coordEnvelope(inv);
  return coordSha256OfCanonicalPayload({ envelope: coordCanonicalJSON(envelope), nonce });
}

// ── Tests ───────────────────────────────────────────────────────────────────

const baseInv: DiLoCoAggregationInvariants = {
  avgGradientNorm: 0.045,
  velocityNorm: 0.032,
  acceptedPeerIds: ['peerB', 'peerA', 'peerC'],
  rejectedPeerIds: [
    { peerId: 'zzz', reason: 'cosine_low' },
    { peerId: 'aaa', reason: 'cosine_nan' },
  ],
  adapterSha256: 'a'.repeat(64),
};

describe('node commitment == coord commitment (byte cross-check)', () => {
  it('canonicalJSON matches the coord algorithm exactly', () => {
    const obj = { z: 1, a: [3, 2, 1], m: { y: 'b', x: 'a' } };
    expect(canonicalJSON(obj)).toBe(coordCanonicalJSON(obj));
  });

  it('envelope sorts accepted + rejected sets like the coord', () => {
    const ours = aggregationInvariantEnvelope(baseInv);
    const theirs = coordEnvelope(baseInv);
    expect(ours).toEqual(theirs);
    // accepted sorted ascending
    expect(ours.acceptedPeerIds).toEqual(['peerA', 'peerB', 'peerC']);
    // rejected sorted by peerId
    expect(ours.rejectedPeerIds.map((r) => r.peerId)).toEqual(['aaa', 'zzz']);
  });

  it('computeCommitment is byte-identical to the coord recompute', () => {
    const nonce = 'deadbeef'.repeat(8);
    expect(computeCommitment(baseInv, nonce)).toBe(coordComputeCommitment(baseInv, nonce));
  });

  it('commitment is stable regardless of input set ordering (sorted envelope)', () => {
    const nonce = 'cafe'.repeat(16);
    const shuffled: DiLoCoAggregationInvariants = {
      ...baseInv,
      acceptedPeerIds: ['peerC', 'peerA', 'peerB'],
      rejectedPeerIds: [
        { peerId: 'aaa', reason: 'cosine_nan' },
        { peerId: 'zzz', reason: 'cosine_low' },
      ],
    };
    expect(computeCommitment(shuffled, nonce)).toBe(computeCommitment(baseInv, nonce));
  });

  it('different nonce → different commitment (binding)', () => {
    expect(computeCommitment(baseInv, 'aa'.repeat(16))).not.toBe(
      computeCommitment(baseInv, 'bb'.repeat(16)),
    );
  });

  it('empty nonce throws (P2 fail-closed)', () => {
    expect(() => computeCommitment(baseInv, '')).toThrow(/nonce is required/);
  });
});
