import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Allowlist of origins that the node-local HTTP servers (a2a, inference)
 * accept for CORS. Pre-S0.5 these servers responded with
 * `Access-Control-Allow-Origin: *`, which made them trivially callable
 * from any tab open in the operator's browser — combined with DNS
 * rebinding, an attacker site could pivot to localhost and drive the
 * agent (audit P0 #5).
 *
 * Only same-machine UIs talk to these servers:
 *   - the desktop Tauri shell (file:// / tauri://localhost)
 *   - a developer running the dashboard locally on http(s)://localhost
 *
 * Cross-origin browser requests from anywhere else are denied. Server-
 * to-server callers (no `Origin` header) are unaffected — the node-side
 * NodeSignatureGuard and per-route auth still apply.
 */
const ORIGIN_ALLOWLIST: ReadonlyArray<RegExp> = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^https?:\/\/\[::1\](:\d+)?$/i,
  /^tauri:\/\/localhost$/i,
];

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, X-Public-Key, X-Peer-Id, X-Signature, X-Timestamp, Authorization';

/**
 * Decide whether `origin` is on the local-only allowlist.
 */
export function isAllowedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return ORIGIN_ALLOWLIST.some(re => re.test(origin));
}

/**
 * Apply restrictive CORS to `res`. Echoes the request `Origin` only
 * when it is on the allowlist. Sets Vary: Origin so caches don't pin
 * the wrong policy.
 *
 * Returns true when the (preflight) request was answered and the
 * caller should stop processing it; false otherwise.
 */
export function applyLocalCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = (req.headers['origin'] as string | undefined) ?? undefined;
  if (origin && isAllowedLocalOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    // No `Allow-Credentials: true` — local-only flows don't need
    // cookie auth and enabling it raises the bar for any future
    // tightening.
  }

  if (req.method === 'OPTIONS') {
    if (origin && !isAllowedLocalOrigin(origin)) {
      // Origin present but not allowed → reject preflight outright so
      // the browser surfaces a blocked-CORS error instead of letting
      // the actual request fly.
      res.writeHead(403);
      res.end('CORS origin not allowed');
      return true;
    }
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
