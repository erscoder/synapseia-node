/**
 * Tests for `handleKgShardOwnership`.
 *
 * Plan D.4.
 */
import { generateKeyPairSync, sign as nodeSign } from 'crypto';
import { handleKgShardOwnership } from '../kg-shard-ownership';
import { canonicalJson } from '../../protocols/kg-shard-envelope';
import { KgShardOwnershipStore } from '../../kg-shard/KgShardOwnershipStore';

interface KP {
  rawPubKey: Uint8Array;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeKP(): KP {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { rawPubKey: der.subarray(12), privateKey };
}

function buildMsg(opts: {
  body: Record<string, unknown>;
  publishedAt: number;
  privateKey: KP['privateKey'];
  signedBy?: string;
}): Uint8Array {
  const canonical = canonicalJson({
    body: opts.body,
    publishedAt: opts.publishedAt,
  });
  const sig = nodeSign(null, Buffer.from(canonical, 'utf8'), opts.privateKey);
  const env = {
    body: opts.body,
    publishedAt: opts.publishedAt,
    signedBy: opts.signedBy ?? 'coordinator_authority',
    signature: Buffer.from(sig).toString('hex'),
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

describe('handleKgShardOwnership', () => {
  const NOW = 1_700_000_000_000;
  let kp: KP;
  let store: KgShardOwnershipStore;

  beforeEach(() => {
    kp = makeKP();
    store = new KgShardOwnershipStore(() => NOW);
  });

  it('upserts the grant when peerId matches and envelope is valid', async () => {
    const expiresAt = NOW + 7 * 24 * 60 * 60 * 1000;
    const msg = buildMsg({
      body: { peerId: 'me', shardId: 5, signature: 'sig-hex', expiresAt },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    const warn = jest.fn();
    await handleKgShardOwnership({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      warn,
      now: () => NOW,
    });
    expect(store.has(5)).toBe(true);
    expect(store.expiresAt(5)).toBe(expiresAt);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores grants for other peers without warning', async () => {
    const msg = buildMsg({
      body: { peerId: 'other', shardId: 5, signature: 'x', expiresAt: NOW + 1000 },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    const warn = jest.fn();
    await handleKgShardOwnership({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      warn,
      now: () => NOW,
    });
    expect(store.has(5)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats expiresAt <= now as a revocation', async () => {
    store.set(5, NOW + 60_000);
    expect(store.has(5)).toBe(true);

    const msg = buildMsg({
      body: { peerId: 'me', shardId: 5, signature: 'x', expiresAt: NOW - 1 },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    await handleKgShardOwnership({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      now: () => NOW,
    });
    expect(store.has(5)).toBe(false);
  });

  it('drops forged signatures', async () => {
    const forger = makeKP();
    const msg = buildMsg({
      body: { peerId: 'me', shardId: 5, signature: 'x', expiresAt: NOW + 1000 },
      publishedAt: NOW,
      privateKey: forger.privateKey,
    });
    const warn = jest.fn();
    await handleKgShardOwnership({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      warn,
      now: () => NOW,
    });
    expect(store.has(5)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/envelope rejected/));
  });

  it('drops malformed JSON', async () => {
    const warn = jest.fn();
    await handleKgShardOwnership({
      pubkey: kp.rawPubKey,
      msg: new TextEncoder().encode('not-json{'),
      thisPeerId: 'me',
      store,
      warn,
      now: () => NOW,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid envelope shape/));
  });

  it('drops envelopes with missing body fields', async () => {
    const msg = buildMsg({
      body: { peerId: 'me', shardId: 5 }, // no expiresAt / signature
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });
    const warn = jest.fn();
    await handleKgShardOwnership({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      warn,
      now: () => NOW,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing required fields/));
  });
});
