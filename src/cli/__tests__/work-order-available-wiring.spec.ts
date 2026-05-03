/**
 * Wiring spec for the signed-envelope WORK_ORDER_AVAILABLE handler.
 *
 * Verifies that the raw-bytes handler installed on the P2P subscriber
 * rejects forged envelopes (consumer never invoked) and accepts genuine
 * ones (consumer receives the WO). The trust anchor is no longer
 * loaded from env — it's a hardcoded `COORDINATOR_PUBKEY_BASE58`
 * constant — so this test passes a synthetic raw pubkey directly to
 * exercise the verifier path without coupling to the production
 * constant. Loader correctness is covered separately in
 * `coordinator-pubkey.spec.ts`.
 *
 * Plan: Tier-2 §2.2.3, refined plan D dev cleanup (2026-05-03).
 */
import { generateKeyPairSync, sign } from 'crypto';

import { handleWorkOrderAvailable } from '../../p2p/topics/work-order-available';

interface KeyPair {
  rawPubKey: Buffer;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { rawPubKey: publicKeyDer.subarray(12), privateKey };
}

function buildEnvelope(wo: { id: string; [k: string]: unknown }, ts: number, pk: KeyPair['privateKey']): Uint8Array {
  const signed = Buffer.from(JSON.stringify({ wo, ts }), 'utf8');
  const sig = sign(null, signed, pk);
  return new TextEncoder().encode(
    JSON.stringify({ wo, ts, sig: Buffer.from(sig).toString('base64') }),
  );
}

/** Minimal stand-in for `P2PNode` capturing the raw-bytes handler. */
class FakeP2PNode {
  private rawCb: ((data: Uint8Array) => void | Promise<void>) | null = null;
  onRawMessage(_topic: string, cb: (data: Uint8Array) => void | Promise<void>): void {
    this.rawCb = cb;
  }
  async deliver(msg: Uint8Array): Promise<void> {
    if (this.rawCb) await this.rawCb(msg);
  }
}

describe('node-runtime wiring — signed WORK_ORDER_AVAILABLE', () => {
  // Mirrors the production wiring block in `node-runtime.ts`: install
  // a raw-bytes handler that delegates to `handleWorkOrderAvailable`
  // with the trusted pubkey already in hand.
  function wireVerifiedHandler(opts: {
    pubkey: Uint8Array;
    p2p: FakeP2PNode;
    consumer: (wo: { id: string; [k: string]: unknown }) => void;
  }): void {
    opts.p2p.onRawMessage('/synapseia/work-order/1.0.0', async (raw) => {
      await handleWorkOrderAvailable({
        pubkey: opts.pubkey,
        msg: raw,
        consumer: opts.consumer,
      });
    });
  }

  it('rejects forged envelopes (consumer not called)', async () => {
    const trusted = makeKeyPair();
    const forger = makeKeyPair();

    const consumer = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkey: trusted.rawPubKey, p2p, consumer });

    // Forger signs a perfectly-shaped, fresh envelope with the WRONG key.
    const ts = Math.floor(Date.now() / 1000);
    const forged = buildEnvelope({ id: 'wo-forged' }, ts, forger.privateKey);
    await p2p.deliver(forged);

    expect(consumer).not.toHaveBeenCalled();
  });

  it('forwards verified envelopes to the consumer', async () => {
    const trusted = makeKeyPair();

    const consumer = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkey: trusted.rawPubKey, p2p, consumer });

    const ts = Math.floor(Date.now() / 1000);
    const wo = { id: 'wo-good', missionId: 'm-1' };
    const real = buildEnvelope(wo, ts, trusted.privateKey);
    await p2p.deliver(real);

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith(wo);
  });
});
