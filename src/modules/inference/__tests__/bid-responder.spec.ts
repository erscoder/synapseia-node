/**
 * BidResponder — comprehensive spec (Phase 4 mutation coverage).
 *
 * Covers start()'s capability filter, handleAuction's validation
 * guards, env-based price bounds, model-version advertisement, signed
 * canonical contract (peerId + priceUsd + modelVersion + quoteId), and
 * publish failure resilience.
 *
 * We do NOT mock identity.sign / canonicalPayload — ESM immutable
 * bindings refuse spyOn on the module. Instead we pass a real hex
 * privateKey (Node crypto's Ed25519) and verify produced signatures
 * end-to-end.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import { BidResponder } from '../bid-responder';

// ── real Ed25519 keypair (hex) ────────────────────────────────────────────
function freshKeypair(): { privHex: string; pubHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return { privHex: priv.toString('hex'), pubHex: pub.toString('hex') };
}

const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd25519(sig: string, msg: string, pubHex: string): boolean {
  const spki = Buffer.concat([SPKI_HEADER, Buffer.from(pubHex, 'hex')]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(msg, 'utf-8'), key, Buffer.from(sig, 'hex'));
}

function canonicalOf(quoteId: string, peerId: string, priceUsd: number, modelVersion = ''): string {
  return JSON.stringify({ modelVersion, peerId, priceUsd, quoteId });
}

// ── Collaborator fakes ────────────────────────────────────────────────────
function makeP2P() {
  const handlers = {} as Record<string, (data: Record<string, unknown>) => void>;
  return {
    handlers,
    publish: jest.fn(async () => undefined) as any,
    onMessage: jest.fn((topic, cb) => { handlers[topic as string] = cb as any; }) as any,
    getPeerId: jest.fn(() => '12D3KooPEER') as any,
    fire: (topic: string, data: Record<string, unknown>) => handlers[topic](data),
  } as any;
}

function makeIdentity(priv?: string, pub?: string) {
  const kp = freshKeypair();
  return {
    peerId: 'hex-peer-0123',
    privateKey: priv ?? kp.privHex,
    publicKey: pub ?? kp.pubHex,
    mnemonic: '', nodeName: 'n', version: 1,
  } as any;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...savedEnv };
  delete process.env.QUERY_MIN_PRICE;
  delete process.env.QUERY_MAX_PRICE;
});
afterEach(() => { process.env = { ...savedEnv }; });

// ── start() capability gate ───────────────────────────────────────────────
describe('BidResponder.start — capability gate', () => {
  it('no-ops when the node lacks any inference capability', () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['heartbeat'], identity: makeIdentity() }).start();
    expect(p2p.onMessage).not.toHaveBeenCalled();
  });

  it('subscribes when `inference` capability is present', () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity() }).start();
    expect(p2p.onMessage).toHaveBeenCalledTimes(1);
    expect(p2p.onMessage.mock.calls[0][0]).toBe('/synapseia/chat-auction/1.0.0');
  });

  it('subscribes when `cpu_inference` capability is present', () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['cpu_inference'], identity: makeIdentity() }).start();
    expect(p2p.onMessage).toHaveBeenCalled();
  });

  it('subscribes when `gpu_inference` capability is present', () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['gpu_inference'], identity: makeIdentity() }).start();
    expect(p2p.onMessage).toHaveBeenCalled();
  });
});

// ── handleAuction validation ──────────────────────────────────────────────
describe('BidResponder.handleAuction — validation guards', () => {
  it('drops messages missing quoteId', async () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity() }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { query: 'what is als' });
    await new Promise((r) => setImmediate(r));
    expect(p2p.publish).not.toHaveBeenCalled();
  });

  it('drops messages missing query', async () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity() }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q1' });
    await new Promise((r) => setImmediate(r));
    expect(p2p.publish).not.toHaveBeenCalled();
  });

  it('drops expired auctions (deadline < Date.now())', async () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity() }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q', query: 'q', deadline: 1 });
    await new Promise((r) => setImmediate(r));
    expect(p2p.publish).not.toHaveBeenCalled();
  });

  it('deadline=0 is treated as "no deadline" (bid proceeds)', async () => {
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity() }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q', query: 'hi', deadline: 0 });
    await new Promise((r) => setImmediate(r));
    expect(p2p.publish).toHaveBeenCalled();
  });
});

// ── handleAuction bid shape ───────────────────────────────────────────────
describe('BidResponder.handleAuction — bid shape', () => {
  it('publishes a full bid payload with signature, publicKey, libp2pPeerId', async () => {
    const p2p = makeP2P();
    const identity = makeIdentity();
    new BidResponder(p2p, { capabilities: ['inference'], identity }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q-abc', query: 'als gene', deadline: Date.now() + 10_000 });
    await new Promise((r) => setImmediate(r));
    expect(p2p.publish).toHaveBeenCalledWith(
      '/synapseia/chat-bid/1.0.0',
      expect.objectContaining({
        version: 1,
        quoteId: 'q-abc',
        peerId: identity.peerId,
        libp2pPeerId: '12D3KooPEER',
        publicKey: identity.publicKey,
        signature: expect.any(String),
      }),
    );
  });

  it('priceUsd respects QUERY_MIN_PRICE / QUERY_MAX_PRICE env bounds', async () => {
    process.env.QUERY_MIN_PRICE = '2.0';
    process.env.QUERY_MAX_PRICE = '5.0';
    const p2p = makeP2P();
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity() }).start();
    // Empty query is rejected by the validator; use a short real one.
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q', query: 'hi', deadline: Date.now() + 10_000 });
    await new Promise((r) => setImmediate(r));
    const payload = p2p.publish.mock.calls[0][1];
    expect(payload.priceUsd).toBeGreaterThanOrEqual(2.0);
    expect(payload.priceUsd).toBeLessThanOrEqual(5.0);
  });

  it('signature is verifiable against the canonical 4-field payload (C6 contract)', async () => {
    const p2p = makeP2P();
    const identity = makeIdentity();
    new BidResponder(p2p, { capabilities: ['inference'], identity }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'qZ', query: 'als', deadline: Date.now() + 1000 });
    await new Promise((r) => setImmediate(r));
    const payload = p2p.publish.mock.calls[0][1];
    const canonical = canonicalOf(payload.quoteId, payload.peerId, payload.priceUsd, '');
    expect(verifyEd25519(payload.signature, canonical, payload.publicKey)).toBe(true);
  });

  it('tampered priceUsd fails signature verification', async () => {
    const p2p = makeP2P();
    const identity = makeIdentity();
    new BidResponder(p2p, { capabilities: ['inference'], identity }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'qT', query: 'x', deadline: Date.now() + 1000 });
    await new Promise((r) => setImmediate(r));
    const payload = p2p.publish.mock.calls[0][1];
    const tampered = canonicalOf(payload.quoteId, payload.peerId, payload.priceUsd + 99, '');
    expect(verifyEd25519(payload.signature, tampered, payload.publicKey)).toBe(false);
  });

  it('advertises modelVersion when synapseiaClient.getActiveVersion() returns one', async () => {
    const p2p = makeP2P();
    const client = { getActiveVersion: jest.fn(() => 'synapseia-agent:gen-1:v3') } as any;
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity(), synapseiaClient: client }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q', query: 'hi', deadline: Date.now() + 1000 });
    await new Promise((r) => setImmediate(r));
    const payload = p2p.publish.mock.calls[0][1];
    expect(payload.modelVersion).toBe('synapseia-agent:gen-1:v3');
  });

  it('omits modelVersion when synapseiaClient reports null (cloud-only path)', async () => {
    const p2p = makeP2P();
    const client = { getActiveVersion: jest.fn(() => null) } as any;
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity(), synapseiaClient: client }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q', query: 'hi', deadline: Date.now() + 1000 });
    await new Promise((r) => setImmediate(r));
    const payload = p2p.publish.mock.calls[0][1];
    expect(payload.modelVersion).toBeUndefined();
  });

  it('canonical signs modelVersion so a spoof lifts verification (C6 guard)', async () => {
    const p2p = makeP2P();
    const identity = makeIdentity();
    const client = { getActiveVersion: jest.fn(() => 'synapseia-agent:gen-2:v0') } as any;
    new BidResponder(p2p, { capabilities: ['inference'], identity, synapseiaClient: client }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'qMV', query: 'hi', deadline: Date.now() + 1000 });
    await new Promise((r) => setImmediate(r));
    const payload = p2p.publish.mock.calls[0][1];
    // Honest canonical (includes modelVersion) verifies.
    const honest = canonicalOf(payload.quoteId, payload.peerId, payload.priceUsd, 'synapseia-agent:gen-2:v0');
    expect(verifyEd25519(payload.signature, honest, payload.publicKey)).toBe(true);
    // Spoofed canonical (claims a newer gen) fails.
    const spoofed = canonicalOf(payload.quoteId, payload.peerId, payload.priceUsd, 'synapseia-agent:gen-99:v99');
    expect(verifyEd25519(payload.signature, spoofed, payload.publicKey)).toBe(false);
  });

  it('cloud-only bids sign canonical with empty-string modelVersion', async () => {
    const p2p = makeP2P();
    const identity = makeIdentity();
    new BidResponder(p2p, { capabilities: ['inference'], identity }).start();
    p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'qCloud', query: 'hi', deadline: Date.now() + 1000 });
    await new Promise((r) => setImmediate(r));
    const payload = p2p.publish.mock.calls[0][1];
    const emptyMv = canonicalOf(payload.quoteId, payload.peerId, payload.priceUsd, '');
    expect(verifyEd25519(payload.signature, emptyMv, payload.publicKey)).toBe(true);
  });

  it('swallows publish errors without throwing', async () => {
    const p2p = makeP2P();
    p2p.publish.mockRejectedValueOnce(new Error('gossip down'));
    new BidResponder(p2p, { capabilities: ['inference'], identity: makeIdentity() }).start();
    expect(() => p2p.fire('/synapseia/chat-auction/1.0.0', { quoteId: 'q', query: 'hi', deadline: Date.now() + 1000 }))
      .not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
