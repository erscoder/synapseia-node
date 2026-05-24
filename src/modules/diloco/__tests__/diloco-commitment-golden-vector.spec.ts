/**
 * GOLDEN-VECTOR cross-package pin for the DiLoCo commit-reveal commitment.
 *
 * The sibling cross-check spec (`diloco-aggregation-commitment.spec.ts`)
 * re-implements the coord's algorithm INLINE, so a future coord-side change
 * to `canonicalJSON` / `aggregationInvariantEnvelope` / `computeCommitment`
 * would NOT fail this node suite — silently breaking commit-reveal consensus.
 *
 * This golden vector closes that gap: a fixed invariants object + nonce is
 * committed VERBATIM in BOTH packages
 * (`packages/node/.../diloco-commitment-golden-vector.json` and
 * `packages/coordinator/.../diloco-commitment-golden-vector.json`) with the
 * SAME `expectedCommitment` hash. Each package has its own test pinning that
 * hash against its own `computeCommitment`. If EITHER side drifts its hashing
 * pipeline, that side's golden test fails on its own — no live cross-import
 * needed. To intentionally change the algorithm you must edit BOTH fixtures,
 * which makes the consensus-breaking change loud and deliberate.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeCommitment, type DiLoCoAggregationInvariants } from '../diloco-aggregation-commitment';

interface GoldenVector {
  invariants: DiLoCoAggregationInvariants;
  nonce: string;
  expectedCommitment: string;
}

const golden = JSON.parse(
  readFileSync(join(__dirname, 'diloco-commitment-golden-vector.json'), 'utf8'),
) as GoldenVector;

describe('DiLoCo commitment golden vector (cross-package pin)', () => {
  it('node computeCommitment produces the committed golden hash', () => {
    expect(computeCommitment(golden.invariants, golden.nonce)).toBe(golden.expectedCommitment);
  });

  it('the golden commitment is a 64-char lowercase sha256 hex', () => {
    expect(golden.expectedCommitment).toMatch(/^[0-9a-f]{64}$/);
  });
});
