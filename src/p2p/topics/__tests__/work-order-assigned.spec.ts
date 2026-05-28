/**
 * D-P2P Slice 2 (2026-05-28) — tests for `handleWorkOrderAssigned`, the
 * node-side handler for the signed, TARGETED `WORK_ORDER_ASSIGNED`
 * gossipsub envelope.
 *
 * Covers: keep IFF targetPeerId === myPeerId, drop+no-enqueue otherwise,
 * forged-sig reject, stale reject, malformed reject, and that a matched
 * WO is handed to the consumer (the node-runtime feeds this to the shared
 * WorkOrderPushQueue → drain path).
 */
import { generateKeyPairSync, sign } from 'crypto';

import { resetStats } from '../../protocols/coord-sig-stats';

interface KeyPair {
  rawPubKey: Uint8Array;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPubKey = publicKeyDer.subarray(12);
  return { rawPubKey, privateKey };
}

function buildEnvelope(opts: {
  payload: { targetPeerId: string; wo: { id: string; [k: string]: unknown }; seq?: number };
  ts: number;
  privateKey: KeyPair['privateKey'];
}): Uint8Array {
  const signedBytes = Buffer.from(
    JSON.stringify({ payload: opts.payload, ts: opts.ts }),
    'utf8',
  );
  const sig = sign(null, signedBytes, opts.privateKey);
  const envelope = {
    payload: opts.payload,
    ts: opts.ts,
    sig: Buffer.from(sig).toString('base64'),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

const SAMPLE_WO = { id: 'wo-42', type: 'cpu_inference', requiredCapabilities: ['cpu_inference'] };

describe('handleWorkOrderAssigned', () => {
  let kp: KeyPair;
  let now: number;

  beforeEach(() => {
    kp = makeKeyPair();
    now = 1_700_000_000;
    resetStats();
  });

  it('KEEPS + forwards the WO to the consumer when targetPeerId === myPeerId', async () => {
    const { handleWorkOrderAssigned } = await import('../work-order-assigned');
    const msg = buildEnvelope({
      payload: { targetPeerId: 'peer-MINE', wo: SAMPLE_WO, seq: 42 },
      ts: now,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAssigned({
      pubkey: kp.rawPubKey,
      msg,
      myPeerId: 'peer-MINE',
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith(expect.objectContaining({ id: 'wo-42' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('DROPS (no enqueue) when targetPeerId !== myPeerId', async () => {
    const { handleWorkOrderAssigned } = await import('../work-order-assigned');
    const msg = buildEnvelope({
      payload: { targetPeerId: 'peer-OTHER', wo: SAMPLE_WO, seq: 1 },
      ts: now,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAssigned({
      pubkey: kp.rawPubKey,
      msg,
      myPeerId: 'peer-MINE',
      consumer,
      warn,
      now: () => now * 1000,
    });

    // Verified + fresh, but not my target → silently dropped, no consumer,
    // no warn (it's a valid envelope, just not addressed to me).
    expect(consumer).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops forged signatures with a warn (does not reach the target filter)', async () => {
    const { handleWorkOrderAssigned } = await import('../work-order-assigned');
    const forger = makeKeyPair();
    const msg = buildEnvelope({
      payload: { targetPeerId: 'peer-MINE', wo: SAMPLE_WO },
      ts: now,
      privateKey: forger.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAssigned({
      pubkey: kp.rawPubKey,
      msg,
      myPeerId: 'peer-MINE',
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid signature/));
  });

  it('drops envelopes older than 60 s', async () => {
    const { handleWorkOrderAssigned } = await import('../work-order-assigned');
    const msg = buildEnvelope({
      payload: { targetPeerId: 'peer-MINE', wo: SAMPLE_WO },
      ts: now - 120,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAssigned({
      pubkey: kp.rawPubKey,
      msg,
      myPeerId: 'peer-MINE',
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stale envelope/));
  });

  it('drops malformed JSON', async () => {
    const { handleWorkOrderAssigned } = await import('../work-order-assigned');
    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAssigned({
      pubkey: kp.rawPubKey,
      msg: new TextEncoder().encode('not-json{'),
      myPeerId: 'peer-MINE',
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid envelope shape/));
  });

  it('drops envelope missing payload.targetPeerId', async () => {
    const { handleWorkOrderAssigned } = await import('../work-order-assigned');
    const msg = buildEnvelope({
      payload: { wo: SAMPLE_WO } as never,
      ts: now,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAssigned({
      pubkey: kp.rawPubKey,
      msg,
      myPeerId: 'peer-MINE',
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing payload\.targetPeerId/));
  });

  it('drops envelope missing inner wo.id (targeted at me but malformed wo)', async () => {
    const { handleWorkOrderAssigned } = await import('../work-order-assigned');
    const msg = buildEnvelope({
      payload: { targetPeerId: 'peer-MINE', wo: {} as { id: string } },
      ts: now,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleWorkOrderAssigned({
      pubkey: kp.rawPubKey,
      msg,
      myPeerId: 'peer-MINE',
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing wo\.id/));
  });
});
