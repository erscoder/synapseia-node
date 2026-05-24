/**
 * Spec for the coordinator dial-address builder (the WS-transport fix).
 *
 * The node must dial the public Fly coordinator over the TLS-terminated
 * secure-WebSocket multiaddr (`/dns4/<host>/tcp/443/wss/p2p/<peerId>`)
 * because raw TCP 9000 is RESET by the Fly shared-IP edge. Local / dev
 * hosts keep the legacy raw-TCP-9000 behaviour. These are pure-function
 * assertions — no live network.
 */
import {
  buildCoordDialAddrs,
  hostPrefixFor,
  isFlyEdgeHost,
  FLY_EDGE_WSS_PORT,
  RAW_TCP_PORT,
  type CoordDialContext,
} from '../coord-dial-addr';

const PEER = '12D3KooWAbCdEf123456';

describe('isFlyEdgeHost', () => {
  it('matches the public coordinator host', () => {
    expect(isFlyEdgeHost('api.synapseia.network')).toBe(true);
  });
  it('matches any *.fly.dev host (case-insensitive)', () => {
    expect(isFlyEdgeHost('synapseia-coord-http.fly.dev')).toBe(true);
    expect(isFlyEdgeHost('SYNAPSEIA-COORD-HTTP.FLY.DEV')).toBe(true);
  });
  it('does not match localhost / arbitrary hosts', () => {
    expect(isFlyEdgeHost('localhost')).toBe(false);
    expect(isFlyEdgeHost('127.0.0.1')).toBe(false);
    expect(isFlyEdgeHost('coord.internal.example.com')).toBe(false);
  });
});

describe('hostPrefixFor', () => {
  it('uses /ip4/127.0.0.1 for localhost', () => {
    expect(hostPrefixFor({ host: 'localhost', isLocalhost: true })).toBe('/ip4/127.0.0.1');
  });
  it('uses /dns4/<host> for remote hosts', () => {
    expect(hostPrefixFor({ host: 'api.synapseia.network', isLocalhost: false })).toBe(
      '/dns4/api.synapseia.network',
    );
  });
});

describe('buildCoordDialAddrs — public Fly coordinator', () => {
  const ctx: CoordDialContext = {
    host: 'api.synapseia.network',
    isLocalhost: false,
    peerId: PEER,
  };

  it('prefers the secure-WS /tcp/443/wss multiaddr first', () => {
    const addrs = buildCoordDialAddrs(ctx);
    expect(addrs[0]).toBe(`/dns4/api.synapseia.network/tcp/${FLY_EDGE_WSS_PORT}/wss/p2p/${PEER}`);
    expect(addrs[0]).toBe(`/dns4/api.synapseia.network/tcp/443/wss/p2p/${PEER}`);
  });

  it('keeps raw TCP 9000 as a secondary candidate', () => {
    const addrs = buildCoordDialAddrs(ctx);
    expect(addrs).toContain(`/dns4/api.synapseia.network/tcp/${RAW_TCP_PORT}/p2p/${PEER}`);
    // wss must come before the raw TCP fallback.
    const wssIdx = addrs.findIndex((a) => a.includes('/wss/'));
    const tcpIdx = addrs.findIndex((a) => a.includes(`/tcp/${RAW_TCP_PORT}/p2p/`));
    expect(wssIdx).toBeGreaterThanOrEqual(0);
    expect(tcpIdx).toBeGreaterThan(wssIdx);
  });

  it('never emits the container-internal /tcp/9001/ws form', () => {
    const addrs = buildCoordDialAddrs(ctx);
    expect(addrs.some((a) => a.includes('/tcp/9001/'))).toBe(false);
    expect(addrs.some((a) => a.endsWith('/ws/p2p/' + PEER))).toBe(false);
  });

  it('applies to *.fly.dev hosts too', () => {
    const addrs = buildCoordDialAddrs({
      host: 'synapseia-coord-http.fly.dev',
      isLocalhost: false,
      peerId: PEER,
    });
    expect(addrs[0]).toBe(`/dns4/synapseia-coord-http.fly.dev/tcp/443/wss/p2p/${PEER}`);
  });
});

describe('buildCoordDialAddrs — local / dev coordinator', () => {
  it('keeps only raw TCP 9000 for localhost (no wss, no TLS edge)', () => {
    const addrs = buildCoordDialAddrs({ host: 'localhost', isLocalhost: true, peerId: PEER });
    expect(addrs).toEqual([`/ip4/127.0.0.1/tcp/${RAW_TCP_PORT}/p2p/${PEER}`]);
    expect(addrs.some((a) => a.includes('/wss'))).toBe(false);
  });

  it('keeps raw TCP 9000 for a non-Fly remote (dedicated-IP / self-hosted)', () => {
    const addrs = buildCoordDialAddrs({
      host: 'coord.internal.example.com',
      isLocalhost: false,
      peerId: PEER,
    });
    expect(addrs).toEqual([`/dns4/coord.internal.example.com/tcp/${RAW_TCP_PORT}/p2p/${PEER}`]);
    expect(addrs.some((a) => a.includes('/wss'))).toBe(false);
  });
});

describe('buildCoordDialAddrs — invariants', () => {
  it('produces no duplicate addresses', () => {
    const addrs = buildCoordDialAddrs({
      host: 'api.synapseia.network',
      isLocalhost: false,
      peerId: PEER,
    });
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it('every candidate carries the /p2p/<peerId> suffix', () => {
    const addrs = buildCoordDialAddrs({
      host: 'api.synapseia.network',
      isLocalhost: false,
      peerId: PEER,
    });
    for (const a of addrs) expect(a.endsWith(`/p2p/${PEER}`)).toBe(true);
  });
});
