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
function coordSortCosineKeys(
  perPeerCosine: Readonly<Record<string, number | 'NaN'>>,
): Record<string, number | 'NaN'> {
  const out: Record<string, number | 'NaN'> = {};
  for (const peerId of Object.keys(perPeerCosine).sort()) {
    out[peerId] = perPeerCosine[peerId];
  }
  return out;
}
function coordEnvelope(inv: DiLoCoAggregationInvariants) {
  const acceptedPeerIds = [...inv.acceptedPeerIds].sort();
  const rejectedPeerIds = [...inv.rejectedPeerIds]
    .map((r) => ({ peerId: r.peerId, reason: r.reason }))
    .sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
  const envelope: {
    avgGradientNorm: number;
    velocityNorm: number;
    acceptedPeerIds: string[];
    rejectedPeerIds: Array<{ peerId: string; reason: string }>;
    adapterSha256: string;
    perPeerCosine?: Record<string, number | 'NaN'>;
  } = {
    avgGradientNorm: inv.avgGradientNorm,
    velocityNorm: inv.velocityNorm,
    acceptedPeerIds,
    rejectedPeerIds,
    adapterSha256: inv.adapterSha256,
  };
  // Phase 2 omit-seam: only ADD the key when present (mirrors coord source).
  if (inv.perPeerCosine !== undefined) {
    envelope.perPeerCosine = coordSortCosineKeys(inv.perPeerCosine);
  }
  return envelope;
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

  // ── Phase 2: perPeerCosine carried under the commitment ────────────────────

  // A peerId→cosine map with UNSORTED keys + a "NaN" STRING value (the literal
  // the Python aggregator emits for an undefined cosine, NOT JS NaN).
  const baseInvWithCosine: DiLoCoAggregationInvariants = {
    ...baseInv,
    perPeerCosine: { peerB: 0.91, peerA: 0.95, peerC: 'NaN' },
  };

  it('present perPeerCosine: commitment is byte-identical to the coord recompute', () => {
    const nonce = 'deadbeef'.repeat(8);
    expect(computeCommitment(baseInvWithCosine, nonce)).toBe(
      coordComputeCommitment(baseInvWithCosine, nonce),
    );
  });

  it('perPeerCosine is bound under the commitment (present ≠ absent)', () => {
    const nonce = 'deadbeef'.repeat(8);
    // If the cosine were dropped before hashing, these would be equal — proving
    // the alignment signal is actually carried under the commit-reveal.
    expect(computeCommitment(baseInvWithCosine, nonce)).not.toBe(
      computeCommitment(baseInv, nonce),
    );
  });

  it('perPeerCosine commitment is stable regardless of map key ordering', () => {
    const nonce = 'cafe'.repeat(16);
    const reordered: DiLoCoAggregationInvariants = {
      ...baseInv,
      perPeerCosine: { peerC: 'NaN', peerB: 0.91, peerA: 0.95 },
    };
    expect(computeCommitment(reordered, nonce)).toBe(
      computeCommitment(baseInvWithCosine, nonce),
    );
  });

  // GOLDEN backward-compat lock (LOAD-BEARING — commit-reveal is LIVE in prod).
  // An OLD node's reveal carries no perPeerCosine; the omit-seam must keep the
  // commitment byte-identical to the pre-phase-2 envelope FOREVER. This pins the
  // absolute hash so ANY future drift in canonicalJSON / envelope field order /
  // the omit-seam (even a coordinated node+coord change) breaks this test before
  // it silently rejects in-flight production reveals with HTTP 403.
  it('GOLDEN: absent perPeerCosine reproduces the pre-phase-2 commitment hash', () => {
    expect(computeCommitment(baseInv, 'deadbeef'.repeat(8))).toBe(
      '7eb42a423690c9423168469d3ccb8b64faa0325b93c21a131c8529de2a286323',
    );
  });
});
