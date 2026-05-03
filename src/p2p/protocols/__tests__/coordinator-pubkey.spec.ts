/**
 * Tests for `loadCoordinatorPubkey` — the trust-anchor decoder for
 * signed coordinator envelopes. The pubkey is hardcoded in source
 * (plan D dev cleanup, 2026-05-03), so the loader is now zero-arg and
 * just decodes + length-checks the constant.
 */

describe('loadCoordinatorPubkey', () => {
  it('decodes the hardcoded COORDINATOR_PUBKEY_BASE58 to a 32-byte raw pubkey', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    const pubkey = loadCoordinatorPubkey();
    expect(pubkey).toHaveLength(32);
  });

  it('returns a stable result across calls (idempotent decode)', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    const a = loadCoordinatorPubkey();
    const b = loadCoordinatorPubkey();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('exports COORDINATOR_PUBKEY_BASE58 as a non-empty base58 string', async () => {
    const { COORDINATOR_PUBKEY_BASE58 } = await import('../coordinator-pubkey');
    expect(typeof COORDINATOR_PUBKEY_BASE58).toBe('string');
    expect(COORDINATOR_PUBKEY_BASE58.length).toBeGreaterThan(40);
    // Sanity: only base58 alphabet characters (no `0`, `O`, `I`, `l`).
    expect(COORDINATOR_PUBKEY_BASE58).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});
