/**
 * Build the ordered list of libp2p dial multiaddrs the node uses to reach
 * the coordinator. Pure + side-effect-free so it can be unit-tested without
 * a live network (`node-runtime.ts` consumes it for both the initial dial
 * and the 30s watchdog reconnect).
 *
 * ── Why this exists (the connectivity bug it fixes) ─────────────────────────
 * The node historically dialed only `/dns4/<host>/tcp/9000/p2p/<peerId>` over
 * a `tcp()`-only transport. On the coordinator's Fly **shared IPv4**, raw TCP
 * 9000 is NOT routable — the Fly edge RESETs non-HTTP traffic, so the dial
 * never completes (`ECONNRESET` / "Unexpected EOF") and `connected=false`
 * sticks forever. The coordinator also listens/announces a WebSocket
 * transport on `/tcp/9001/ws`, and Fly's `[http]` handler on 9001 makes the
 * **secure** form reachable on the shared IP via TLS terminated at 443. So
 * the edge-reachable libp2p multiaddr for the public coord is
 * `/dns4/<host>/tcp/443/wss/p2p/<peerId>` (NOT `/tcp/9001/ws`, which is the
 * container-internal port — the external port is 443/https).
 *
 * `@multiformats/multiaddr-matcher`'s `WebSocketsSecure` matcher confirms
 * `/dns4/<host>/tcp/443/wss/...` is a valid secure-WS dial, and
 * `@libp2p/websockets` v10 dials all WS/WSS multiaddrs by default.
 */

/** Hosts that resolve to a Fly shared-IP coordinator behind the HTTP edge. */
const FLY_EDGE_HOST_SUFFIXES = ['.fly.dev'] as const;
/** The canonical public coordinator hostname (also Fly-fronted). */
const PUBLIC_COORD_HOSTS = ['api.synapseia.network'] as const;

/** The TLS-terminated external port Fly exposes for the WS `[http]` handler. */
export const FLY_EDGE_WSS_PORT = 443;
/** The raw-TCP gossip port (reachable on local/dev / dedicated-IP hosts). */
export const RAW_TCP_PORT = 9000;
/** The container-internal WS port (announced by the coord, not edge-reachable). */
export const INTERNAL_WS_PORT = 9001;

export interface CoordDialContext {
  /** Bare host (no scheme, no port), e.g. `api.synapseia.network` or `127.0.0.1`. */
  readonly host: string;
  /** Whether the configured coordinator URL points at localhost / 127.0.0.1. */
  readonly isLocalhost: boolean;
  /** The coordinator's live libp2p peerId from `GET /p2p/bootstrap`. */
  readonly peerId: string;
}

/** A host is Fly-edge-fronted when it is the public coord or any `*.fly.dev`. */
export function isFlyEdgeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PUBLIC_COORD_HOSTS.includes(h as (typeof PUBLIC_COORD_HOSTS)[number])) return true;
  return FLY_EDGE_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/** `/ip4/127.0.0.1` for localhost, otherwise `/dns4/<host>`. */
export function hostPrefixFor(ctx: Pick<CoordDialContext, 'host' | 'isLocalhost'>): string {
  return ctx.isLocalhost ? '/ip4/127.0.0.1' : `/dns4/${ctx.host}`;
}

/**
 * Produce the ordered list of dial candidates for the coordinator. libp2p
 * dials each in turn until one connects, so ORDER = preference.
 *
 *  - Public Fly host (api.synapseia.network / *.fly.dev): prefer the
 *    edge-reachable secure WS `/dns4/<host>/tcp/443/wss/p2p/<peerId>` first;
 *    keep `/dns4/<host>/tcp/9000/...` (raw TCP) as a secondary attempt for
 *    the day the coord moves to a dedicated IP. We deliberately do NOT emit
 *    `/tcp/9001/ws`: 9001 is the container-internal port, not the external
 *    edge port, so a direct dial to it from outside Fly cannot connect.
 *  - Local / dev / non-Fly host: keep the existing `/tcp/9000` raw-TCP
 *    behaviour (works on localhost and dedicated-IP deployments). No WSS —
 *    a local coord has no TLS edge in front of it.
 *
 * Duplicates are removed while preserving first-seen order.
 */
export function buildCoordDialAddrs(ctx: CoordDialContext): string[] {
  const prefix = hostPrefixFor(ctx);
  const suffix = `/p2p/${ctx.peerId}`;
  const candidates: string[] = [];

  if (!ctx.isLocalhost && isFlyEdgeHost(ctx.host)) {
    // Fly edge: secure WS over 443 first (the only form that connects on a
    // shared IP), raw TCP 9000 as a fallback for non-shared-IP futures.
    candidates.push(`${prefix}/tcp/${FLY_EDGE_WSS_PORT}/wss${suffix}`);
    candidates.push(`${prefix}/tcp/${RAW_TCP_PORT}${suffix}`);
  } else {
    // Local / dev / non-Fly: raw TCP 9000 (unchanged legacy behaviour).
    candidates.push(`${prefix}/tcp/${RAW_TCP_PORT}${suffix}`);
  }

  return dedupePreserveOrder(candidates);
}

function dedupePreserveOrder(addrs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    if (!seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}
