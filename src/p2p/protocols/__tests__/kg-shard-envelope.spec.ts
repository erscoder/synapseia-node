/**
 * Tests for the node-side `verifyKgShardEnvelope`.
 *
 * Round-trip via Node `crypto` to confirm both sides of the contract
 * agree byte-for-byte. Also covers tamper detection + replay window.
 *
 * Plan D.4.
 */
import { generateKeyPairSync, sign as nodeSign } from 'crypto';
import {
  canonicalJson,
  KG_SHARD_ENVELOPE_MAX_AGE_MS,
  type KgShardSignedEnvelope,
  verifyKgShardEnvelope,
} from '../kg-shard-envelope';

interface KeyPair {
  rawPubKey: Uint8Array;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  // 12-byte SPKI prefix + 32-byte raw pubkey.
  const rawPubKey = publicKeyDer.subarray(12);
  return { rawPubKey, privateKey };
}

function buildEnvelope(opts: {
  body: Record<string, unknown>;
  publishedAt: number;
  privateKey: KeyPair['privateKey'];
}): KgShardSignedEnvelope {
  const canonical = canonicalJson({
    body: opts.body,
    publishedAt: opts.publishedAt,
  });
  const sig = nodeSign(null, Buffer.from(canonical, 'utf8'), opts.privateKey);
  return {
    body: opts.body,
    publishedAt: opts.publishedAt,
    signedBy: 'coordinator_authority',
    signature: Buffer.from(sig).toString('hex'),
  };
}

describe('verifyKgShardEnvelope', () => {
  const NOW = 1_700_000_000_000;
  let kp: KeyPair;

  beforeEach(() => {
    kp = makeKeyPair();
  });

  it('accepts a freshly signed envelope', () => {
    const env = buildEnvelope({
      body: { peerId: 'peer-1', shardId: 3, signature: 'deadbeef', expiresAt: NOW + 1000 },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result).toEqual({ valid: true });
  });

  it('rejects when signedBy is wrong', () => {
    const env = buildEnvelope({
      body: { peerId: 'p', shardId: 0, signature: 'x', expiresAt: NOW + 1 },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    (env as { signedBy: string }).signedBy = 'someone_else';
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signedBy/);
  });

  it('rejects forged signatures', () => {
    const forger = makeKeyPair();
    const env = buildEnvelope({
      body: { peerId: 'p', shardId: 0, signature: 'x', expiresAt: NOW + 1 },
      publishedAt: NOW,
      privateKey: forger.privateKey,
    });
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/ed25519 verify returned false/);
  });

  it('rejects tampered body even when signature is structurally valid', () => {
    const env = buildEnvelope({
      body: { peerId: 'p', shardId: 0, signature: 'x', expiresAt: NOW + 1 },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    // Mutate the body after signing — signature should now fail.
    (env.body as { shardId: number }).shardId = 99;
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/ed25519 verify returned false/);
  });

  it('rejects envelopes older than the replay window', () => {
    const stalePublishedAt = NOW - KG_SHARD_ENVELOPE_MAX_AGE_MS - 1;
    const env = buildEnvelope({
      body: { peerId: 'p', shardId: 0, signature: 'x', expiresAt: NOW + 1 },
      publishedAt: stalePublishedAt,
      privateKey: kp.privateKey,
    });
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/publishedAt/);
  });

  it('rejects envelopes from too far in the future', () => {
    const env = buildEnvelope({
      body: { peerId: 'p', shardId: 0, signature: 'x', expiresAt: NOW + 1 },
      publishedAt: NOW + 60_000,
      privateKey: kp.privateKey,
    });
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/publishedAt/);
  });

  it('rejects malformed signature hex', () => {
    const env = buildEnvelope({
      body: { peerId: 'p', shardId: 0, signature: 'x', expiresAt: NOW + 1 },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    env.signature = 'not-hex-z';
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed|length/);
  });

  it('rejects signatures with the wrong byte length', () => {
    const env = buildEnvelope({
      body: { peerId: 'p', shardId: 0, signature: 'x', expiresAt: NOW + 1 },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    env.signature = 'aa';
    const result = verifyKgShardEnvelope(env, kp.rawPubKey, { now: () => NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/length/);
  });

  it('canonicalJson sorts keys at every level', () => {
    const a = canonicalJson({ b: 1, a: 2, nested: { z: 9, y: 8 } });
    const b = canonicalJson({ a: 2, nested: { y: 8, z: 9 }, b: 1 });
    expect(a).toBe(b);
  });
});
