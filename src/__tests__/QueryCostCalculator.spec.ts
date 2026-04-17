import { computeQueryPriceUsd, priceUsdFromEnv } from '../modules/inference/QueryCostCalculator';

/**
 * Parity + unit tests. The node copy of QueryCostCalculator MUST produce the
 * same price as the coordinator's for any given input; this test encodes the
 * expected price for a fixed sample set so any drift in either copy is
 * caught before it reaches a real auction. Keep this list in sync with
 * `packages/coordinator/src/application/inference/__tests__/QueryCostCalculator.spec.ts`
 * — if you change the heuristic, update both sets of expectations.
 */

describe('computeQueryPriceUsd (node)', () => {
  const cfg = { minPriceUsd: 0.1, maxPriceUsd: 1.0 };

  it('returns min for empty query', () => {
    expect(computeQueryPriceUsd('', cfg)).toBe(0.1);
    expect(computeQueryPriceUsd('   ', cfg)).toBe(0.1);
  });

  it('prices a short trivial question near the floor', () => {
    const p = computeQueryPriceUsd('Hello', cfg);
    expect(p).toBeGreaterThanOrEqual(0.1);
    expect(p).toBeLessThan(0.3);
  });

  it('prices a long technical biomedical query near the ceiling', () => {
    const p = computeQueryPriceUsd(
      'What are the latest randomized double-blind clinical trials of SOD1 and C9orf72 ' +
        'therapies in ALS patients? Cite DOIs from PubMed and include source references ' +
        'and ```code``` snippets for the statistical methods used.',
      cfg,
    );
    expect(p).toBeGreaterThan(0.7);
    expect(p).toBeLessThanOrEqual(1.0);
  });

  it('respects env-configured bounds', () => {
    const p = computeQueryPriceUsd('Hello', { minPriceUsd: 0.05, maxPriceUsd: 0.5 });
    expect(p).toBeGreaterThanOrEqual(0.05);
    expect(p).toBeLessThanOrEqual(0.5);
  });

  it('clamps when max <= min (defensive)', () => {
    expect(computeQueryPriceUsd('whatever', { minPriceUsd: 0.5, maxPriceUsd: 0.3 })).toBe(0.5);
  });

  it('is deterministic for the same input', () => {
    const q = 'Explain the SOD1 gene mutation in ALS';
    expect(computeQueryPriceUsd(q, cfg)).toBe(computeQueryPriceUsd(q, cfg));
  });

  it('rewards citation requests even on short queries', () => {
    const base = computeQueryPriceUsd('ALS therapy', cfg);
    const withCite = computeQueryPriceUsd('ALS therapy cite DOIs', cfg);
    expect(withCite).toBeGreaterThan(base);
  });
});

/**
 * Parity vector — exact numeric outputs shared with the coordinator copy.
 * If either side's heuristic changes, both numbers must be updated together
 * and this test will flag the drift first.
 */
describe('QueryCostCalculator parity vector (coordinator ↔ node)', () => {
  const cfg = { minPriceUsd: 0.1, maxPriceUsd: 1.0 };
  const samples: Array<{ query: string; expected: number }> = [
    { query: '', expected: 0.1 },
    { query: 'Hello', expected: 0.117308 }, // 1 word, no biomed, no citation
    // A fully-loaded query: 20+ words, 5+ biomedical terms, has ```code```, has "cite".
    {
      query:
        'What are the latest randomized double-blind clinical trials of SOD1 and C9orf72 ' +
          'therapies in ALS patients? Cite DOIs from PubMed and include source references ' +
          'and ```code``` snippets for the statistical methods used.',
      expected: 1.0,
    },
    { query: 'ALS therapy cite DOIs', expected: 0.411538 }, // 4 words, 2 biomed (als+doi), +0.3 citation
  ];

  it.each(samples)('matches coordinator for "%s"', ({ query, expected }) => {
    expect(computeQueryPriceUsd(query, cfg)).toBeCloseTo(expected, 4);
  });
});

describe('priceUsdFromEnv', () => {
  const original = { min: process.env.QUERY_MIN_PRICE, max: process.env.QUERY_MAX_PRICE };

  afterAll(() => {
    process.env.QUERY_MIN_PRICE = original.min;
    process.env.QUERY_MAX_PRICE = original.max;
  });

  it('reads env at call time', () => {
    process.env.QUERY_MIN_PRICE = '0.2';
    process.env.QUERY_MAX_PRICE = '2.0';
    expect(priceUsdFromEnv('')).toBe(0.2);
  });

  it('falls back to defaults when env unset', () => {
    delete process.env.QUERY_MIN_PRICE;
    delete process.env.QUERY_MAX_PRICE;
    expect(priceUsdFromEnv('')).toBe(0.1);
  });
});
