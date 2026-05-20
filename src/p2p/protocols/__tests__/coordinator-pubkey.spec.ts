/**
 * Tests for `loadCoordinatorPubkey` — the trust-anchor decoder for
 * signed coordinator envelopes. The pubkey is hardcoded in source
 * (plan D dev cleanup, 2026-05-03), so the loader is now zero-arg and
 * just decodes + length-checks the constant.
 *
 * F-node-002 (BLOCKER) golden-vector coverage: the inline base58
 * decoder used by `loadCoordinatorPubkey` MUST match the canonical
 * `bs58` package bit-for-bit. Any divergence used to silently downgrade
 * the gossipsub work-order subscription to an UNVERIFIED handler; the
 * fail-open path has since been removed, but the decoder is still the
 * thing that gates every coord-signed topic, so parity is mandatory.
 */
import bs58 from 'bs58';

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

  it('inline decoder agrees with canonical `bs58` on the hardcoded constant', async () => {
    const { _decodeBase58ForTest, COORDINATOR_PUBKEY_BASE58 } = await import(
      '../coordinator-pubkey'
    );
    const inline = _decodeBase58ForTest(COORDINATOR_PUBKEY_BASE58);
    const canonical = bs58.decode(COORDINATOR_PUBKEY_BASE58);
    expect(Buffer.from(inline).equals(Buffer.from(canonical))).toBe(true);
  });
});

describe('inline base58 decoder — golden vectors vs canonical bs58', () => {
  // Fixed-byte golden vectors. Each tuple is the literal string the
  // inline decoder must produce the same Uint8Array for as `bs58.decode`.
  // Mix of:
  //   - leading-zero patterns (`1...` = leading 0x00 bytes)
  //   - Ed25519-pubkey-sized (32-byte decode targets)
  //   - boundary lengths (1, 2, 3, 4 raw bytes)
  //   - varied alphabet coverage (digits + upper + lower)
  const GOLDEN_VECTORS = [
    // Single-char alphabet table.
    '1', // [0x00]
    '2', // [0x01]
    '9', // [0x08]
    'A', // [0x09]
    'z', // [0x39]
    // Leading-1 = leading-zero byte tests.
    '11', // [0x00, 0x00]
    '11111111', // 8 leading-zero bytes
    '12', // [0x00, 0x01]
    // Mid-length tests.
    '21', // [0x3A]
    '4uQeVj', // 4-byte payload, arbitrary
    'BukQL', // mixed alphabet
    // Solana-pubkey-sized (32 raw bytes → typically 43-44 base58 chars).
    'AzhtjmKerYgURY6sxSZBPu3GBD7nfzdP8n2mYiAqUs3u',
    '11111111111111111111111111111111', // 32 leading-zero bytes = Solana SystemProgram
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token program id
    'So11111111111111111111111111111111111111112', // Wrapped SOL mint
    // Longer / Bitcoin-address-style vectors.
    '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX',
    // Empty string — both should produce zero-length buffer.
    '',
  ];

  it.each(GOLDEN_VECTORS)('matches canonical bs58.decode for %p', async (input) => {
    const { _decodeBase58ForTest } = await import('../coordinator-pubkey');
    const inline = _decodeBase58ForTest(input);
    const canonical = bs58.decode(input);
    expect(Buffer.from(inline).equals(Buffer.from(canonical))).toBe(true);
    expect(inline.length).toBe(canonical.length);
  });

  it('throws on invalid base58 character (matches canonical rejection)', async () => {
    const { _decodeBase58ForTest } = await import('../coordinator-pubkey');
    // `0`, `O`, `I`, `l` are all explicitly excluded from base58.
    for (const bad of ['0xyz', 'OK1', 'Il0o', 'foo!bar']) {
      expect(() => _decodeBase58ForTest(bad)).toThrow();
      expect(() => bs58.decode(bad)).toThrow();
    }
  });
});
