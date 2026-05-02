/**
 * Tests for `handleKgQueryRedirect`.
 *
 * Plan D.4.
 */
import { generateKeyPairSync, sign as nodeSign } from 'crypto';
import { handleKgQueryRedirect, type IKgQueryDialer } from '../kg-query-redirect';
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
}): Uint8Array {
  const canonical = canonicalJson({
    body: opts.body,
    publishedAt: opts.publishedAt,
  });
  const sig = nodeSign(null, Buffer.from(canonical, 'utf8'), opts.privateKey);
  const env = {
    body: opts.body,
    publishedAt: opts.publishedAt,
    signedBy: 'coordinator_authority' as const,
    signature: Buffer.from(sig).toString('hex'),
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

describe('handleKgQueryRedirect', () => {
  const NOW = 1_700_000_000_000;
  let kp: KP;
  let store: KgShardOwnershipStore;

  beforeEach(() => {
    kp = makeKP();
    store = new KgShardOwnershipStore(() => NOW);
  });

  it('dials the requester when the shard is held', async () => {
    store.set(4, NOW + 60_000);
    const dialer: IKgQueryDialer = {
      query: jest.fn().mockResolvedValue({ ok: true, shardId: 4, hits: [] }),
    };
    const msg = buildMsg({
      body: {
        shardId: 4,
        requesterPeerId: 'req-1',
        queryId: 'q-1',
        query: 'hello',
        embedding: null,
        k: 5,
      },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });

    const warn = jest.fn();
    await handleKgQueryRedirect({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      dialer,
      warn,
      now: () => NOW,
    });

    expect(dialer.query).toHaveBeenCalledTimes(1);
    expect(dialer.query).toHaveBeenCalledWith('req-1', {
      shardId: 4,
      embedding: null,
      query: 'hello',
      k: 5,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('silently no-ops when the shard is not held', async () => {
    const dialer: IKgQueryDialer = { query: jest.fn() };
    const msg = buildMsg({
      body: {
        shardId: 4,
        requesterPeerId: 'req-1',
        queryId: 'q-1',
        query: 'x',
        embedding: null,
        k: 1,
      },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });

    const warn = jest.fn();
    await handleKgQueryRedirect({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      dialer,
      warn,
      now: () => NOW,
    });

    expect(dialer.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects forged envelopes and never dials', async () => {
    store.set(4, NOW + 60_000);
    const forger = makeKP();
    const dialer: IKgQueryDialer = { query: jest.fn() };
    const msg = buildMsg({
      body: {
        shardId: 4,
        requesterPeerId: 'req-1',
        queryId: 'q-1',
        query: 'x',
        embedding: null,
        k: 1,
      },
      publishedAt: NOW,
      privateKey: forger.privateKey,
    });

    const warn = jest.fn();
    await handleKgQueryRedirect({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      dialer,
      warn,
      now: () => NOW,
    });

    expect(dialer.query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/envelope rejected/));
  });

  it('logs a warn when the dial fails but does not throw', async () => {
    store.set(4, NOW + 60_000);
    const dialer: IKgQueryDialer = {
      query: jest.fn().mockRejectedValue(new Error('dial timeout')),
    };
    const msg = buildMsg({
      body: {
        shardId: 4,
        requesterPeerId: 'req-1',
        queryId: 'q-1',
        query: 'x',
        embedding: null,
        k: 1,
      },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });

    const warn = jest.fn();
    await expect(
      handleKgQueryRedirect({
        pubkey: kp.rawPubKey,
        msg,
        thisPeerId: 'me',
        store,
        dialer,
        warn,
        now: () => NOW,
      }),
    ).resolves.toBeUndefined();

    expect(dialer.query).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dial.*failed/));
  });

  it('refuses to redirect to itself', async () => {
    store.set(4, NOW + 60_000);
    const dialer: IKgQueryDialer = { query: jest.fn() };
    const msg = buildMsg({
      body: {
        shardId: 4,
        requesterPeerId: 'me',
        queryId: 'q-1',
        query: 'x',
        embedding: null,
        k: 1,
      },
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });

    await handleKgQueryRedirect({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      dialer,
      now: () => NOW,
    });
    expect(dialer.query).not.toHaveBeenCalled();
  });

  it('drops envelopes with missing body fields', async () => {
    store.set(4, NOW + 60_000);
    const dialer: IKgQueryDialer = { query: jest.fn() };
    const msg = buildMsg({
      body: { shardId: 4, requesterPeerId: 'req' }, // missing queryId, k, query/embedding
      publishedAt: NOW,
      privateKey: kp.privateKey,
    });

    const warn = jest.fn();
    await handleKgQueryRedirect({
      pubkey: kp.rawPubKey,
      msg,
      thisPeerId: 'me',
      store,
      dialer,
      warn,
      now: () => NOW,
    });
    expect(dialer.query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing required fields/));
  });
});
