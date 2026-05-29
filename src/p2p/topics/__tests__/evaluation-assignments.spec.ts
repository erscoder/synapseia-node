/**
 * Tests for `handleEvaluationAssignments` — the node-side handler for
 * signed `EVALUATION_ASSIGNMENTS` gossipsub envelopes.
 *
 * Plan: Tier-3 §3.C.1.
 */
import { generateKeyPairSync, sign } from 'crypto';

import { resetStats } from '../../protocols/coord-sig-stats';
import { ReplayGuard } from '../replay-guard';
import {
  DOMAIN_EVAL_ASSIGNMENTS,
  DOMAIN_WO_ASSIGNED,
} from '../verify-coordinator-envelope';

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
  /** Override the domain tag the signature is minted under (cross-type test). */
  domain?: string;
}): Uint8Array {
  // Signed bytes are the domain-tagged { domain, body, ts } wrapper (body =
  // the payload); the wire envelope keeps the { payload, ts, sig } shape.
  const signedBytes = Buffer.from(
    JSON.stringify({
      domain: opts.domain ?? DOMAIN_EVAL_ASSIGNMENTS,
      body: opts.payload,
      ts: opts.ts,
    }),
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
    resetStats();
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
    // New diagnostic format includes the sigPrefix.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sigPrefix=/));
  });

  it('rate-limits repeated invalid-sig WARNs to one per fingerprint per window', async () => {
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    const forger = makeKeyPair();
    const msg = buildEnvelope({
      payload: { nodeId: 'node-burst' },
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
    await handleEvaluationAssignments({
      pubkey: kp.rawPubKey,
      msg,
      consumer,
      warn,
      now: () => now * 1000,
    });

    expect(consumer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
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

  // ── Cross-type signature replay (the core vuln this closes) ──────────────
  it('REJECTS a signature minted under the WORK_ORDER_ASSIGNED domain', async () => {
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    // Sign with the REAL coordinator key but under the ASSIGNED domain. The
    // wire envelope is a perfectly-shaped EVALUATION_ASSIGNMENTS envelope; the
    // eval handler reconstructs under DOMAIN_EVAL_ASSIGNMENTS → verify fails.
    const msg = buildEnvelope({
      payload: { nodeId: 'node-cross' },
      ts: now,
      privateKey: kp.privateKey,
      domain: DOMAIN_WO_ASSIGNED,
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

  // ── Replay guard ─────────────────────────────────────────────────────────
  it('rejects a REPLAYED envelope (same valid sig verified twice with a shared guard)', async () => {
    const { handleEvaluationAssignments } = await import('../evaluation-assignments');
    const msg = buildEnvelope({
      payload: { nodeId: 'node-replay' },
      ts: now,
      privateKey: kp.privateKey,
    });
    const replayGuard = new ReplayGuard(60);

    const consumer = jest.fn();
    const warn = jest.fn();
    const call = () =>
      handleEvaluationAssignments({
        pubkey: kp.rawPubKey,
        msg,
        consumer,
        warn,
        now: () => now * 1000,
        replayGuard,
      });

    await call(); // accepted
    await call(); // replay

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/replayed envelope/));
  });
});
