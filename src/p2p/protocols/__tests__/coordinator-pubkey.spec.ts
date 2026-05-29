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
import { jest } from '@jest/globals';
import bs58 from 'bs58';
import * as crypto from 'crypto';

import { DOMAIN_WO_AVAILABLE } from '../../topics/verify-coordinator-envelope';

// PINNED trust anchor. The coordinator-pubkey constant is the Ed25519
// public key every coord-signed gossip topic is verified against; an
// UNINTENDED change here silently re-points the trust anchor of the whole
// fleet. Pinning the decoded raw bytes means a rotation can only land via
// a deliberate edit to BOTH the source constant AND this expected value
// (a release event, per coordinator-pubkey.ts rotation ceremony) — a stray
// edit fails the build instead of shipping a wrong anchor.
//
// Value derived from COORDINATOR_PUBKEY_BASE58 =
//   '7RoGRRdZnDWzFqD6Sn5S7RpRq3SLWUfrgsLRJ4S4tNew'
// (fp=9ca842c955bb30e7, the 2026-05-28 rotation recorded in source).
const PINNED_COORD_PUBKEY_HEX =
  '5f805fbccdc63bde13489cc2e8c00480712fe06a2caba393ec42b30456c05194';

// ASN.1 DER PKCS8 header for a raw 32-byte Ed25519 private scalar (RFC 8410).
const ED25519_PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Generate a raw 32-byte Ed25519 keypair (priv scalar + raw pub). */
function newEd25519Key(): { privRaw: Buffer; pubRaw: Uint8Array } {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privRaw = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  const pubDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  return { privRaw: Buffer.from(privRaw), pubRaw: new Uint8Array(pubDer.subarray(-32)) };
}

/** Sign `messageBytes` with a raw 32-byte Ed25519 private scalar. */
function signRaw(messageBytes: Buffer, privRaw: Buffer): Buffer {
  const der = Buffer.concat([ED25519_PKCS8_HEADER, privRaw]);
  const keyObject = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, messageBytes, keyObject);
}

/**
 * Build a `WORK_ORDER_AVAILABLE` gossip envelope ({wo, ts, sig}) signed
 * over the domain-tagged `JSON.stringify({domain, body: wo, ts})` exactly as
 * CoordinatorPublisher does, encoded to the raw message bytes the handler
 * consumes. The wire envelope keeps the unchanged { wo, ts, sig } shape.
 */
function buildSignedEnvelope(privRaw: Buffer, ts: number): Uint8Array {
  const wo = {
    id: 'wo-1',
    title: 'Test WO',
    status: 'available',
    rewardAmount: '1000',
    requiredCapabilities: ['gpu'],
    creatorAddress: 'creator-1',
  };
  const signed = JSON.stringify({ domain: DOMAIN_WO_AVAILABLE, body: wo, ts });
  const sig = signRaw(Buffer.from(signed, 'utf8'), privRaw).toString('base64');
  return new TextEncoder().encode(JSON.stringify({ wo, ts, sig }));
}

describe('loadCoordinatorPubkey', () => {
  it('decodes the hardcoded COORDINATOR_PUBKEY_BASE58 to a 32-byte raw pubkey', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    const pubkey = loadCoordinatorPubkey();
    expect(pubkey).toHaveLength(32);
  });

  it('decodes to the PINNED trust-anchor bytes (an unintended rotation fails here)', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    const pubkey = loadCoordinatorPubkey();
    expect(Buffer.from(pubkey).toString('hex')).toBe(PINNED_COORD_PUBKEY_HEX);
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

describe('trust-anchor wiring — handleWorkOrderAvailable gates on the pubkey it is given', () => {
  // The loader is only the FIRST half of the trust anchor; the gate that
  // matters at runtime is the signature check inside
  // handleWorkOrderAvailable, which verifies each envelope against the
  // pubkey it is handed (loadCoordinatorPubkey() in production). These
  // tests prove that gate end-to-end with real Ed25519 envelopes:
  //   - an envelope NOT signed by the trust anchor is DROPPED (consumer
  //     never invoked) when verified against the real loadCoordinatorPubkey().
  //   - an envelope signed by the matching key is ACCEPTED.
  // NOTE: this spec must NOT touch work-order-available.ts (source owned
  // elsewhere) — it only drives the existing exported handler.
  const FIXED_NOW = 1_717_000_000_000; // ms; envelopes use ts in seconds

  it('DROPS a WORK_ORDER_AVAILABLE envelope signed by a key != loadCoordinatorPubkey()', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    const { handleWorkOrderAvailable } = await import('../../topics/work-order-available');

    // Sign with an attacker key that is NOT the coordinator's.
    const attacker = newEd25519Key();
    const ts = Math.floor(FIXED_NOW / 1000);
    const msg = buildSignedEnvelope(attacker.privRaw, ts);

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAvailable({
      pubkey: loadCoordinatorPubkey(), // verify against the REAL trust anchor
      msg,
      consumer,
      warn,
      now: () => FIXED_NOW,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('ACCEPTS a WORK_ORDER_AVAILABLE envelope signed by the matching pubkey', async () => {
    const { handleWorkOrderAvailable } = await import('../../topics/work-order-available');

    // Positive case: sign with a key and verify against ITS public key —
    // the wiring accepts an envelope whose signature matches the supplied
    // anchor. (The production anchor's private key is secret, so we use a
    // generated keypair to exercise the accept path; the negative case
    // above ties the gate to the real loadCoordinatorPubkey().)
    const coord = newEd25519Key();
    const ts = Math.floor(FIXED_NOW / 1000);
    const msg = buildSignedEnvelope(coord.privRaw, ts);

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAvailable({
      pubkey: coord.pubRaw,
      msg,
      consumer,
      warn,
      now: () => FIXED_NOW,
    });

    expect(consumer).toHaveBeenCalledTimes(1);
    expect((consumer.mock.calls[0][0] as { id: string }).id).toBe('wo-1');
  });
});
