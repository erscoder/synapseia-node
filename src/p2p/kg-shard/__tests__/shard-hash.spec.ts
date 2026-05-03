import { shardIdFor, KG_SHARD_COUNT_DEFAULT } from '../shard-hash';

/**
 * Plan D.4-distribution.3 — node side of the byte-identical shard
 * mapping helper. Mirror of
 * `packages/coordinator/src/application/knowledge-graph/__tests__/shard-hash.spec.ts`.
 * If the algorithm ever changes, both files MUST be updated together.
 */

// HARDCODED — must stay byte-identical with the coord-side fixture.
const FIXTURES: Array<{ id: string; expected: number; expected4: number }> = [
  { id: 'embedding-fixture-001',                   expected: 14, expected4: 2 },
  { id: '00000000-0000-0000-0000-000000000000',    expected: 12, expected4: 0 },
  { id: 'pubmed-39427281-abstract',                expected: 6,  expected4: 2 },
  { id: '🧠-emoji-id',                              expected: 3,  expected4: 3 },
  { id: '',                                        expected: 2,  expected4: 2 },
];

describe('shardIdFor (node)', () => {
  it('returns the same value for the same input across calls', () => {
    for (const f of FIXTURES) {
      expect(shardIdFor(f.id)).toBe(shardIdFor(f.id));
    }
  });

  it('produces a value in [0, shardCount) for the default count', () => {
    for (const f of FIXTURES) {
      const s = shardIdFor(f.id);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(KG_SHARD_COUNT_DEFAULT);
    }
  });

  it('respects a custom shard count', () => {
    for (const f of FIXTURES) {
      const s4 = shardIdFor(f.id, 4);
      expect(s4).toBeGreaterThanOrEqual(0);
      expect(s4).toBeLessThan(4);
      expect(s4).toBe(f.expected4);
    }
  });

  it('matches the locked fixture vector (regression guard)', () => {
    for (const f of FIXTURES) {
      expect(shardIdFor(f.id)).toBe(f.expected);
    }
  });

  it('exports KG_SHARD_COUNT_DEFAULT === 16', () => {
    expect(KG_SHARD_COUNT_DEFAULT).toBe(16);
  });
});
