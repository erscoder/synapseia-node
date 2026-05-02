/**
 * Tests for `handleWorkOrderAvailable` — the node-side handler for
 * signed `WORK_ORDER_AVAILABLE` gossipsub envelopes.
 *
 * Plan: Tier-2 §2.2.2.
 */
import { generateKeyPairSync, sign } from 'crypto';

interface KeyPair {
  rawPubKey: Uint8Array;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  // Strip the 12-byte SPKI prefix to get the raw 32-byte Ed25519 pubkey.
  const rawPubKey = publicKeyDer.subarray(12);
  return { rawPubKey, privateKey };
}

function buildEnvelope(opts: {
  wo: { id: string; missionId?: string; payload?: unknown };
  ts: number;
  privateKey: KeyPair['privateKey'];
}): Uint8Array {
  const signedBytes = Buffer.from(JSON.stringify({ wo: opts.wo, ts: opts.ts }), 'utf8');
  const sig = sign(null, signedBytes, opts.privateKey);
  const envelope = {
    wo: opts.wo,
    ts: opts.ts,
    sig: Buffer.from(sig).toString('base64'),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

describe('handleWorkOrderAvailable', () => {
  let kp: KeyPair;
  let now: number;

  beforeEach(() => {
    kp = makeKeyPair();
    now = 1_700_000_000; // fixed wall-clock for deterministic freshness checks
  });

  it('passes verified WOs to the consumer', async () => {
    const { handleWorkOrderAvailable } = await import('../work-order-available');
    const wo = { id: 'wo-1', missionId: 'mission-A', payload: { kind: 'inference' } };
    const msg = buildEnvelope({ wo, ts: now, privateKey: kp.privateKey });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAvailable({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith(wo);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops forged messages silently with a warn log', async () => {
    const { handleWorkOrderAvailable } = await import('../work-order-available');
    // Sign with a DIFFERENT key — verification must fail.
    const forger = makeKeyPair();
    const wo = { id: 'wo-forged', missionId: 'mission-X' };
    const msg = buildEnvelope({ wo, ts: now, privateKey: forger.privateKey });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAvailable({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid signature/));
  });

  it('drops messages older than 60s', async () => {
    const { handleWorkOrderAvailable } = await import('../work-order-available');
    const wo = { id: 'wo-stale' };
    const oldTs = now - 120; // 2 min in the past
    const msg = buildEnvelope({ wo, ts: oldTs, privateKey: kp.privateKey });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAvailable({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stale envelope/));
  });

  it('drops malformed JSON', async () => {
    const { handleWorkOrderAvailable } = await import('../work-order-available');
    const msg = new TextEncoder().encode('not-json{');

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAvailable({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid envelope shape/));
  });

  it('drops envelope missing wo.id', async () => {
    const { handleWorkOrderAvailable } = await import('../work-order-available');
    // Sign a wo with NO `id` so the signature itself is valid but the
    // payload fails the post-verify shape check.
    const wo = { missionId: 'mission-A' } as unknown as { id: string };
    const msg = buildEnvelope({ wo, ts: now, privateKey: kp.privateKey });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAvailable({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing wo\.id/));
  });
});
