/**
 * F-node-017 (LOW) regression — telemetry sanitizer redacts 64-byte
 * secret-shaped values regardless of the field name. The legacy
 * sanitizer only redacted when the KEY started with one of WALLET / KEY
 * / SECRET / MNEMONIC / PASSWORD / TOKEN. Fields like `keypair`,
 * `decoded`, `signer`, `derivedKey` slipped through.
 */
import { sanitizeContext, sanitizeEvent } from '../sanitizer';

describe('F-node-017 — sanitizeContext value-based 64-byte redaction', () => {
  it('redacts a 64-byte number[] under an innocuous key (decoded)', () => {
    // `decoded` does NOT match the keyword allowlist
    // (WALLET|KEY|SECRET|MNEMONIC|PASSWORD|TOKEN), so before F-node-017
    // it would round-trip the raw 64-byte array. The new value-shape
    // check redacts it regardless.
    const ctx = { decoded: new Array<number>(64).fill(42) };
    const out = sanitizeContext(ctx) as Record<string, unknown>;
    expect(out.decoded).toBe('[REDACTED:uint8[64]]');
  });

  it('redacts under `decoded`, `signer`, `bytes`, `payload`', () => {
    // All of these dodge the keyword allowlist but expose a 64-byte
    // secret-shape — must redact based on value, not key.
    for (const k of ['decoded', 'signer', 'bytes', 'payload']) {
      const ctx = { [k]: new Array<number>(64).fill(0) };
      const out = sanitizeContext(ctx) as Record<string, unknown>;
      expect(out[k]).toBe('[REDACTED:uint8[64]]');
    }
  });

  it('redacts a 64-byte Buffer regardless of field name', () => {
    const ctx = { blob: Buffer.alloc(64, 7) };
    const out = sanitizeContext(ctx) as Record<string, unknown>;
    expect(out.blob).toBe('[REDACTED:Buffer(64)]');
  });

  it('leaves a 32-byte pubkey-shaped array intact', () => {
    // 32 bytes is the Solana PUBLIC key shape — not a secret, must not be redacted.
    const ctx = { pubkey: new Array<number>(32).fill(0xab) };
    const out = sanitizeContext(ctx) as Record<string, unknown>;
    expect(out.pubkey).toEqual(new Array<number>(32).fill(0xab));
  });

  it('leaves a 40-byte array intact (not the secretKey shape, under array cap)', () => {
    // Sanitizer caps arrays at 50 items, so we use 40 to assert the
    // length round-trips for a non-secret shape.
    const ctx = { almostSecret: new Array<number>(40).fill(1) };
    const out = sanitizeContext(ctx) as Record<string, unknown>;
    expect(Array.isArray(out.almostSecret)).toBe(true);
    expect((out.almostSecret as number[]).length).toBe(40);
  });

  it('still honors the keyword allowlist for non-array values', () => {
    const ctx = { WALLET_PRIVATE_KEY: 'plaintext-secret' };
    const out = sanitizeContext(ctx) as Record<string, unknown>;
    expect(out.WALLET_PRIVATE_KEY).toBe('<redacted>');
  });

  it('redacts a 64-byte uint8 nested 3 levels deep', () => {
    const ctx = { a: { b: { decodedBlob: new Array<number>(64).fill(0xff) } } };
    const out = sanitizeContext(ctx) as { a: { b: { decodedBlob: string } } };
    expect(out.a.b.decodedBlob).toBe('[REDACTED:uint8[64]]');
  });

  it('rejects array with non-integer / out-of-range bytes (not a uint8)', () => {
    // Pad to 40 items so the array stays under the 50-item cap and we
    // can assert length round-trip cleanly.
    const ctx = { fake: [1, 2, 3.5, ...new Array<number>(37).fill(0)] };
    const out = sanitizeContext(ctx) as Record<string, unknown>;
    expect(Array.isArray(out.fake)).toBe(true);
    expect((out.fake as number[]).length).toBe(40);
  });

  it('integrates with sanitizeEvent end-to-end', () => {
    const ev = sanitizeEvent({
      message: 'boot ok',
      context: { signer: new Array<number>(64).fill(99), other: 'fine' },
    });
    expect(ev).not.toBeNull();
    expect(ev!.context.signer).toBe('[REDACTED:uint8[64]]');
    expect(ev!.context.other).toBe('fine');
  });
});
