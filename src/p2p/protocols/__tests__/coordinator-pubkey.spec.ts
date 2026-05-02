/**
 * Tests for `loadCoordinatorPubkey` — the trust-anchor loader for the
 * signed `WORK_ORDER_AVAILABLE` envelopes published by the coordinator.
 *
 * Plan: Tier-2 §2.2.1.
 */
import { randomBytes } from 'crypto';

let fixturePubkeyBase58: string;
let fixtureRawPubkey: Buffer;

beforeAll(async () => {
  const { default: bs58 } = await import('bs58');
  fixtureRawPubkey = randomBytes(32);
  fixturePubkeyBase58 = bs58.encode(fixtureRawPubkey);
});

describe('loadCoordinatorPubkey', () => {
  it('returns the Ed25519 pubkey from SYNAPSEIA_COORDINATOR_PUBKEY_BASE58', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    const pubkey = loadCoordinatorPubkey({ pubkeyBase58: fixturePubkeyBase58 });
    expect(pubkey).toHaveLength(32);
    expect(Buffer.from(pubkey).equals(fixtureRawPubkey)).toBe(true);
  });

  it('throws when env is unset', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    expect(() => loadCoordinatorPubkey({ pubkeyBase58: undefined })).toThrow(
      /SYNAPSEIA_COORDINATOR_PUBKEY_BASE58.*required/,
    );
  });

  it('throws when env is empty string', async () => {
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    expect(() => loadCoordinatorPubkey({ pubkeyBase58: '' })).toThrow(
      /SYNAPSEIA_COORDINATOR_PUBKEY_BASE58.*required/,
    );
  });

  it('throws when decoded length is not 32 bytes', async () => {
    const { default: bs58 } = await import('bs58');
    const tooShort = bs58.encode(Buffer.alloc(16, 0));
    const { loadCoordinatorPubkey } = await import('../coordinator-pubkey');
    expect(() => loadCoordinatorPubkey({ pubkeyBase58: tooShort })).toThrow(
      /SYNAPSEIA_COORDINATOR_PUBKEY_BASE58.*32/,
    );
  });
});
