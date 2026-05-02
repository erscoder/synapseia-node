/**
 * Tests for `handleEvaluationAssignments` — the node-side handler for
 * signed `EVALUATION_ASSIGNMENTS` gossipsub envelopes.
 *
 * Plan: Tier-3 §3.C.1.
 */
import { generateKeyPairSync, sign } from 'crypto';

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
  payload: { nodeId: string };
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

describe('handleEvaluationAssignments', () => {
  let kp: KeyPair;
  let now: number;

  beforeEach(() => {
    kp = makeKeyPair();
    now = 1_700_000_000;
  });

  it('forwards verified envelope to consumer with the nodeId payload', async () => {
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    const msg = buildEnvelope({
      payload: { nodeId: 'node-evaluator-1' },
      ts: now,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleEvaluationAssignments({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith({ nodeId: 'node-evaluator-1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops forged signatures with a warn', async () => {
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    const forger = makeKeyPair();
    const msg = buildEnvelope({
      payload: { nodeId: 'node-x' },
      ts: now,
      privateKey: forger.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleEvaluationAssignments({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid signature/));
  });

  it('drops envelopes older than 60 s', async () => {
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    const oldTs = now - 120;
    const msg = buildEnvelope({
      payload: { nodeId: 'node-stale' },
      ts: oldTs,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleEvaluationAssignments({
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
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    const msg = new TextEncoder().encode('not-json{');

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleEvaluationAssignments({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid envelope shape/));
  });

  it('drops envelope missing payload.nodeId', async () => {
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    const msg = buildEnvelope({
      payload: {} as { nodeId: string },
      ts: now,
      privateKey: kp.privateKey,
    });

    const consumer = jest.fn();
    const warn = jest.fn();
    await handleEvaluationAssignments({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing payload\.nodeId/));
  });
});
