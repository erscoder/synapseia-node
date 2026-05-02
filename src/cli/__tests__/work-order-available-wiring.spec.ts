/**
 * Wiring spec for the signed-envelope WORK_ORDER_AVAILABLE handler.
 *
 * Verifies that when `SYNAPSEIA_COORDINATOR_PUBKEY_BASE58` is set, the
 * raw-bytes handler installed on the P2P subscriber rejects forged
 * envelopes (consumer never invoked) and accepts genuine ones (consumer
 * receives the WO). The test wires `loadCoordinatorPubkey` +
 * `handleWorkOrderAvailable` together exactly the way `node-runtime.ts`
 * does, but against a fake `P2PNode.onRawMessage` so we don't need
 * libp2p in unit tests.
 *
 * Plan: Tier-2 §2.2.3.
 */
import { generateKeyPairSync, randomBytes, sign } from 'crypto';

import { loadCoordinatorPubkey } from '../../p2p/protocols/coordinator-pubkey';
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
  // Replicates the production wiring block in `node-runtime.ts`: load
  // the trust anchor at boot, then register a raw-bytes handler that
  // delegates to `handleWorkOrderAvailable`.
  function wireVerifiedHandler(opts: {
    pubkeyBase58: string;
    p2p: FakeP2PNode;
    consumer: (wo: { id: string; [k: string]: unknown }) => void;
  }): void {
    const pubkey = loadCoordinatorPubkey({ pubkeyBase58: opts.pubkeyBase58 });
    opts.p2p.onRawMessage('/synapseia/work-order/1.0.0', async (raw) => {
      await handleWorkOrderAvailable({
        pubkey,
        msg: raw,
        consumer: opts.consumer,
      });
    });
  }

  it('rejects forged envelopes (consumer not called)', async () => {
    const { default: bs58 } = await import('bs58');
    const trusted = makeKeyPair();
    const forger = makeKeyPair();
    const pubkeyBase58 = bs58.encode(trusted.rawPubKey);

    const consumer = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkeyBase58, p2p, consumer });

    // Forger signs a perfectly-shaped, fresh envelope with the WRONG key.
    const ts = Math.floor(Date.now() / 1000);
    const forged = buildEnvelope({ id: 'wo-forged' }, ts, forger.privateKey);
    await p2p.deliver(forged);

    expect(consumer).not.toHaveBeenCalled();
  });

  it('forwards verified envelopes to the consumer', async () => {
    const { default: bs58 } = await import('bs58');
    const trusted = makeKeyPair();
    const pubkeyBase58 = bs58.encode(trusted.rawPubKey);

    const consumer = jest.fn();
    const p2p = new FakeP2PNode();
    wireVerifiedHandler({ pubkeyBase58, p2p, consumer });

    const ts = Math.floor(Date.now() / 1000);
    const wo = { id: 'wo-good', missionId: 'm-1' };
    const real = buildEnvelope(wo, ts, trusted.privateKey);
    await p2p.deliver(real);

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith(wo);
  });

  it('refuses to wire when pubkey env is unset', async () => {
    const consumer = jest.fn();
    const p2p = new FakeP2PNode();
    expect(() =>
      wireVerifiedHandler({
        pubkeyBase58: '' as unknown as string,
        p2p,
        consumer,
      }),
    ).toThrow(/SYNAPSEIA_COORDINATOR_PUBKEY_BASE58/);
  });

  it('refuses to wire when pubkey env is not 32 bytes', async () => {
    const { default: bs58 } = await import('bs58');
    const consumer = jest.fn();
    const p2p = new FakeP2PNode();
    const tooShort = bs58.encode(randomBytes(16));
    expect(() =>
      wireVerifiedHandler({ pubkeyBase58: tooShort, p2p, consumer }),
    ).toThrow(/32/);
  });
});
