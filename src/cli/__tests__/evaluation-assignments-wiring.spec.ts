/**
 * Wiring spec for the signed-envelope EVALUATION_ASSIGNMENTS handler.
 *
 * Mirrors the production wiring block in `node-runtime.ts`: install a
 * raw-bytes handler that delegates to `handleEvaluationAssignments`.
 * The consumer compares the envelope `nodeId` with the local peer and
 * calls `kickReviewCycle` only on match. The trust anchor is hardcoded
 * in `coordinator-pubkey.ts`; this test passes a synthetic raw pubkey
 * directly so each case can exercise verifier behaviour without
 * coupling to the production constant.
 *
 * Plan: Tier-3 §3.C.1, refined plan D dev cleanup (2026-05-03).
 */
import { generateKeyPairSync, sign } from 'crypto';

import { handleEvaluationAssignments } from '../../p2p/topics/evaluation-assignments';
import { ReviewAgentHelper } from '../../modules/agent/review-agent';

interface KeyPair {
  rawPubKey: Buffer;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { rawPubKey: publicKeyDer.subarray(12), privateKey };
}

function buildEnvelope(payload: { nodeId: string }, ts: number, pk: KeyPair['privateKey']): Uint8Array {
  const signed = Buffer.from(JSON.stringify({ payload, ts }), 'utf8');
  const sig = sign(null, signed, pk);
  return new TextEncoder().encode(
    JSON.stringify({ payload, ts, sig: Buffer.from(sig).toString('base64') }),
  );
}

class FakeP2PNode {
  private rawCb: ((data: Uint8Array) => void | Promise<void>) | null = null;
  onRawMessage(_topic: string, cb: (data: Uint8Array) => void | Promise<void>): void {
    this.rawCb = cb;
  }
  async deliver(msg: Uint8Array): Promise<void> {
    if (this.rawCb) await this.rawCb(msg);
  }
}

interface WireOpts {
  pubkey: Uint8Array;
  p2p: FakeP2PNode;
  myPeerId: string;
  kicker: jest.Mock;
}

function wireVerifiedHandler(opts: WireOpts): void {
  opts.p2p.onRawMessage('/synapseia/evaluation-assignments/1.0.0', async (raw) => {
    await handleEvaluationAssignments({
      pubkey: opts.pubkey,
      msg: raw,
      consumer: ({ nodeId }) => {
        if (nodeId !== opts.myPeerId) return;
        opts.kicker();
      },
    });
  });
}

describe('node-runtime wiring — signed EVALUATION_ASSIGNMENTS', () => {
  it('kicks the review cycle exactly once on a matching nodeId', async () => {
    const trusted = makeKeyPair();

    const kicker = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkey: trusted.rawPubKey, p2p, myPeerId: 'peer-A', kicker });

    const ts = Math.floor(Date.now() / 1000);
    await p2p.deliver(buildEnvelope({ nodeId: 'peer-A' }, ts, trusted.privateKey));

    expect(kicker).toHaveBeenCalledTimes(1);
  });

  it('ignores envelopes addressed to a different nodeId (no kick, no warn)', async () => {
    const trusted = makeKeyPair();

    const kicker = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkey: trusted.rawPubKey, p2p, myPeerId: 'peer-A', kicker });

    const ts = Math.floor(Date.now() / 1000);
    await p2p.deliver(buildEnvelope({ nodeId: 'peer-B' }, ts, trusted.privateKey));

    expect(kicker).not.toHaveBeenCalled();
  });

  it('drops forged envelopes (kicker not called)', async () => {
    const trusted = makeKeyPair();
    const forger = makeKeyPair();

    const kicker = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkey: trusted.rawPubKey, p2p, myPeerId: 'peer-A', kicker });

    const ts = Math.floor(Date.now() / 1000);
    await p2p.deliver(buildEnvelope({ nodeId: 'peer-A' }, ts, forger.privateKey));

    expect(kicker).not.toHaveBeenCalled();
  });

  it('drops stale envelopes (>60 s)', async () => {
    const trusted = makeKeyPair();

    const kicker = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkey: trusted.rawPubKey, p2p, myPeerId: 'peer-A', kicker });

    const oldTs = Math.floor(Date.now() / 1000) - 600;
    await p2p.deliver(buildEnvelope({ nodeId: 'peer-A' }, oldTs, trusted.privateKey));

    expect(kicker).not.toHaveBeenCalled();
  });

  it('uses the 10-min HTTP poll interval as the safety net', () => {
    expect(ReviewAgentHelper.POLL_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});
