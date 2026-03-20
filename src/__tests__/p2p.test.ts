import { P2PNode, TOPICS, createP2PNode } from '../p2p.js';
import type { Identity } from '../identity.js';
import { createLibp2p } from 'libp2p';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';

// Mock @noble/ed25519 before importing modules that use it
jest.mock('@noble/ed25519', () => ({
  getPublicKey: jest.fn().mockReturnValue(Buffer.alloc(32)),
  sign: jest.fn().mockResolvedValue(Buffer.alloc(64)),
  verify: jest.fn().mockResolvedValue(true),
}));

// Mock identity signing functions
jest.mock('../identity.js', () => ({
  ...jest.requireActual('../identity.js'),
  sign: jest.fn().mockResolvedValue('mock-signature-hex'),
  canonicalPayload: jest.fn((data: Record<string, unknown>) => JSON.stringify(data)),
}));

const mockCreateLibp2p = createLibp2p as jest.MockedFunction<typeof createLibp2p>;
const mockBootstrap = bootstrap as jest.MockedFunction<typeof bootstrap>;
const mockKadDHT = kadDHT as jest.MockedFunction<typeof kadDHT>;

const mockIdentity: Identity = {
  peerId: 'hex-peer-id',
  publicKey: 'aabb',
  privateKey: 'ccdd',
  createdAt: 1000,
};

function makeMockNode() {
  const msgListeners: Array<(e: CustomEvent) => void> = [];
  const pubsub = {
    addEventListener: jest.fn((_: string, h: (e: CustomEvent) => void) => msgListeners.push(h)),
    subscribe: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    emit(detail: unknown) {
      for (const h of msgListeners) h(new CustomEvent('message', { detail }));
    },
  };
  return {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    peerId: { toString: () => '12D3KooWMock' },
    getMultiaddrs: jest.fn(() => [{ toString: () => '/ip4/127.0.0.1/tcp/4001' }]),
    getPeers: jest.fn(() => [{ toString: () => '12D3KooWA' }, { toString: () => '12D3KooWB' }]),
    services: { pubsub },
  };
}

describe('TOPICS', () => {
  it('defines all 4 gossipsub topics', () => {
    expect(TOPICS.HEARTBEAT).toBe('/synapseia/heartbeat/1.0.0');
    expect(TOPICS.SUBMISSION).toBe('/synapseia/submission/1.0.0');
    expect(TOPICS.LEADERBOARD).toBe('/synapseia/leaderboard/1.0.0');
    expect(TOPICS.PULSE).toBe('/synapseia/pulse/1.0.0');
  });
});

describe('P2PNode', () => {
  let mn: ReturnType<typeof makeMockNode>;

  beforeEach(() => {
    mn = makeMockNode();
    mockCreateLibp2p.mockResolvedValue(mn as never);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('isRunning() is false before start', () => {
    expect(new P2PNode(mockIdentity).isRunning()).toBe(false);
  });

  it('start() creates libp2p and starts it', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    expect(mockCreateLibp2p).toHaveBeenCalledTimes(1);
    expect(mn.start).toHaveBeenCalledTimes(1);
    expect(n.isRunning()).toBe(true);
  });

  it('start() subscribes to all 4 topics', async () => {
    await new P2PNode(mockIdentity).start();
    const subs = mn.services.pubsub.subscribe.mock.calls.map((c: string[]) => c[0]);
    expect(subs).toContain(TOPICS.HEARTBEAT);
    expect(subs).toContain(TOPICS.SUBMISSION);
    expect(subs).toContain(TOPICS.LEADERBOARD);
    expect(subs).toContain(TOPICS.PULSE);
  });

  it('start() uses clientMode=true without bootstrap addrs', async () => {
    mockKadDHT.mockClear();
    await new P2PNode(mockIdentity).start([]);
    expect(mockKadDHT).toHaveBeenCalledWith({ clientMode: true });
  });

  it('start() uses clientMode=false with bootstrap addrs', async () => {
    mockKadDHT.mockClear();
    await new P2PNode(mockIdentity).start(['/ip4/1.2.3.4/tcp/9000']);
    expect(mockKadDHT).toHaveBeenCalledWith({ clientMode: false });
  });

  it('start() includes bootstrap service when addrs provided', async () => {
    mockBootstrap.mockClear();
    await new P2PNode(mockIdentity).start(['/ip4/1.2.3.4/tcp/9000']);
    expect(mockBootstrap).toHaveBeenCalledWith({ list: ['/ip4/1.2.3.4/tcp/9000'] });
  });

  it('stop() stops the node and sets isRunning false', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    await n.stop();
    expect(mn.stop).toHaveBeenCalledTimes(1);
    expect(n.isRunning()).toBe(false);
  });

  it('stop() is safe when not started', async () => {
    await expect(new P2PNode(mockIdentity).stop()).resolves.toBeUndefined();
  });

  it('getPeerId() returns identity peerId before start', () => {
    expect(new P2PNode(mockIdentity).getPeerId()).toBe('hex-peer-id');
  });

  it('getPeerId() returns libp2p peerId after start', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    expect(n.getPeerId()).toBe('12D3KooWMock');
  });

  it('getConnectedPeers() returns [] before start', () => {
    expect(new P2PNode(mockIdentity).getConnectedPeers()).toEqual([]);
  });

  it('getConnectedPeers() returns peer list after start', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    expect(n.getConnectedPeers()).toEqual(['12D3KooWA', '12D3KooWB']);
  });

  it('getMultiaddrs() returns [] before start', () => {
    expect(new P2PNode(mockIdentity).getMultiaddrs()).toEqual([]);
  });

  it('getMultiaddrs() returns addresses after start', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    expect(n.getMultiaddrs()).toEqual(['/ip4/127.0.0.1/tcp/4001']);
  });

  it('publish() throws before start', async () => {
    await expect(new P2PNode(mockIdentity).publish(TOPICS.HEARTBEAT, {})).rejects.toThrow('P2P node not started');
  });

  it('publish() encodes JSON and calls gossipsub', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    const data = { peerId: '12D3', tier: 2 };
    await n.publish(TOPICS.HEARTBEAT, data);
    expect(mn.services.pubsub.publish).toHaveBeenCalledWith(TOPICS.HEARTBEAT, expect.any(Uint8Array));
    const bytes = mn.services.pubsub.publish.mock.calls[0][1] as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(data);
  });

  it('publishHeartbeat() uses HEARTBEAT topic and includes signature', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    const spy = jest.spyOn(n, 'publish').mockResolvedValue(undefined);
    await n.publishHeartbeat({ peerId: 'x', tier: 2 });
    expect(spy).toHaveBeenCalledWith(TOPICS.HEARTBEAT, expect.objectContaining({
      peerId: 'x',
      tier: 2,
      signature: 'mock-signature-hex',
    }));
  });

  it('publishSubmission() uses SUBMISSION topic', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    const spy = jest.spyOn(n, 'publish').mockResolvedValue(undefined);
    await n.publishSubmission({ h: 'test' });
    expect(spy).toHaveBeenCalledWith(TOPICS.SUBMISSION, { h: 'test' });
  });

  it('onMessage() fires handler for matching topic', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    const handler = jest.fn();
    n.onMessage(TOPICS.HEARTBEAT, handler);
    const payload = { peerId: 'remote', tier: 1 };
    mn.services.pubsub.emit({
      topic: TOPICS.HEARTBEAT,
      data: new TextEncoder().encode(JSON.stringify(payload)),
      from: { toString: () => '12D3Remote' },
    });
    expect(handler).toHaveBeenCalledWith(payload, '12D3Remote');
  });

  it('onMessage() ignores different topics', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    const handler = jest.fn();
    n.onMessage(TOPICS.SUBMISSION, handler);
    mn.services.pubsub.emit({
      topic: TOPICS.HEARTBEAT,
      data: new TextEncoder().encode(JSON.stringify({ x: 1 })),
      from: { toString: () => 'p1' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('onMessage() ignores malformed JSON', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    const handler = jest.fn();
    n.onMessage(TOPICS.HEARTBEAT, handler);
    mn.services.pubsub.emit({
      topic: TOPICS.HEARTBEAT,
      data: new TextEncoder().encode('NOT_JSON'),
      from: { toString: () => 'p1' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('onMessage() supports multiple handlers', async () => {
    const n = new P2PNode(mockIdentity);
    await n.start();
    const h1 = jest.fn(); const h2 = jest.fn();
    n.onMessage(TOPICS.HEARTBEAT, h1);
    n.onMessage(TOPICS.HEARTBEAT, h2);
    mn.services.pubsub.emit({
      topic: TOPICS.HEARTBEAT,
      data: new TextEncoder().encode(JSON.stringify({ ok: true })),
      from: { toString: () => 'p1' },
    });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('start() logs "Listening on:" when multiaddrs exist', async () => {
    const consoleSpy = jest.spyOn(console, 'log');
    const n = new P2PNode(mockIdentity);
    await n.start();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[P2P] Listening on:',
      '/ip4/127.0.0.1/tcp/4001',
    );
  });

  it('start() does NOT log "Listening on:" when no multiaddrs', async () => {
    const emptyMn = makeMockNode();
    emptyMn.getMultiaddrs.mockReturnValue([]);
    mockCreateLibp2p.mockResolvedValueOnce(emptyMn as never);
    const consoleSpy = jest.spyOn(console, 'log');
    const n = new P2PNode(mockIdentity);
    await n.start();
    const listeningCalls = consoleSpy.mock.calls.filter(c => String(c[0]).includes('Listening on'));
    expect(listeningCalls).toHaveLength(0);
  });
});

describe('createP2PNode()', () => {
  beforeEach(() => {
    mockCreateLibp2p.mockResolvedValue(makeMockNode() as never);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns a running P2PNode', async () => {
    const n = await createP2PNode(mockIdentity, []);
    expect(n.isRunning()).toBe(true);
  });

  it('passes bootstrapAddrs to start', async () => {
    mockBootstrap.mockClear();
    const addr = '/ip4/9.9.9.9/tcp/9000';
    await createP2PNode(mockIdentity, [addr]);
    expect(mockBootstrap).toHaveBeenCalledWith({ list: [addr] });
  });

  it('works with no args (default empty bootstrapAddrs)', async () => {
    const n = await createP2PNode(mockIdentity);
    expect(n.isRunning()).toBe(true);
  });
});