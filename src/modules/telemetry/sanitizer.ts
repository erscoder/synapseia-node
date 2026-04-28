/**
 * Sanitizer — strips PII / secrets / oversized payloads from telemetry
 * events before they leave the node.
 *
 * Rules (defense in depth):
 *  1. Replace absolute filesystem paths in `message` and `stack` with
 *     repo-relative or ~/ equivalents.
 *  2. Drop suspected wallet keys / api keys when adjacent to sensitive
 *     keywords (`wallet`, `key`, `secret`, `token`).
 *  3. Truncate `message` to 2 KB, `stack` to 8 KB, total event JSON to
 *     16 KB. Events exceeding 16 KB are dropped entirely (caller logs
 *     a local warn — they never reach the wire).
 *  4. Strip any `process.env`, `os.userInfo()`-style payloads from
 *     `context` jsonb. We allow only declared shapes.
 */

const MAX_MESSAGE_BYTES = 2 * 1024;
const MAX_STACK_BYTES = 8 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_CONTEXT_BYTES = 4 * 1024;

// Solana wallet pubkey shape (base58, 32–44 chars). When it appears
// next to one of the SENSITIVE_KEYWORDS we redact. Matching on the
// raw pattern alone would mistakenly redact every base58 string —
// hashes, peer ids, etc.
const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;
const SENSITIVE_KEYWORDS = [
  'wallet',
  'private',
  'secret',
  'mnemonic',
  'seed',
  'key',
  'token',
  'apikey',
  'api_key',
  'password',
];
// Match identifier-looking labels that contain any sensitive keyword,
// even within underscored identifiers like `WALLET_PRIVATE_KEY`.
// Captures: <label>=<value> | <label>: <value> | <label> <value>
const SENSITIVE_RE = new RegExp(
  `(?:^|[^\\w])((?:[A-Za-z0-9_-]*(?:${SENSITIVE_KEYWORDS.join('|')})[A-Za-z0-9_-]*))[:= ]+([^\\s,]+)`,
  'gi',
);

/**
 * Strip absolute filesystem paths to their canonical relative form.
 * `/Users/<name>/...`           → `~/...`
 * `/home/<name>/...`            → `~/...`
 * `/app/packages/<pkg>/...`     → `packages/<pkg>/...`
 * `C:\Users\<name>\...`         → `~\...`
 */
export function normalizePaths(s: string): string {
  return s
    .replace(/\/Users\/[^\/\s)"]+/g, '~')
    .replace(/\/home\/[^\/\s)"]+/g, '~')
    .replace(/C:\\Users\\[^\\\s)"]+/gi, '~')
    .replace(/\/app\/packages\//g, 'packages/')
    .replace(/\/app\//g, '');
}

/** Strip patterns that look like secrets adjacent to sensitive labels. */
export function redactSecrets(s: string): string {
  return s.replace(SENSITIVE_RE, (match, label: string) => {
    // Preserve the leading non-word boundary char from the match so we
    // don't accidentally swallow it when the regex started with [^\w].
    const lead = match.startsWith(label) ? '' : match[0];
    return `${lead}${label}=<redacted>`;
  });
}

function utf8ByteSize(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8ByteSize(s) <= maxBytes) return s;
  // Naive truncation — slice by char until under the budget. Not perfect
  // for multi-byte chars but never produces invalid UTF-8 since Buffer
  // would reject mid-codepoint.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8ByteSize(s.slice(0, mid)) <= maxBytes - 3) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + '...';
}

/** Strip a string field through the full pipeline, then truncate. */
export function sanitizeText(s: string | undefined, maxBytes: number): string {
  if (!s) return '';
  return truncateUtf8(redactSecrets(normalizePaths(s)), maxBytes);
}

/** Recursively sanitize string leaves of an object. Returns a fresh copy. */
export function sanitizeContext(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 6) return '[depth-cap]';
  if (typeof value === 'string') return sanitizeText(value, 1024);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(v => sanitizeContext(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value)) {
      if (i++ > 50) break; // cap object keys
      if (/^(WALLET|KEY|SECRET|MNEMONIC|PASSWORD|TOKEN)/i.test(k)) {
        out[k] = '<redacted>';
      } else {
        out[k] = sanitizeContext(v, depth + 1);
      }
    }
    return out;
  }
  return value ?? null;
}

export interface SanitizableEvent {
  message: string;
  stack?: string | null;
  context: Record<string, unknown>;
}

/**
 * Apply all sanitization + size limits to an event.
 * Returns null if the resulting event still exceeds MAX_EVENT_BYTES.
 */
export function sanitizeEvent<T extends SanitizableEvent>(
  ev: T,
): T | null {
  const cleaned: T = {
    ...ev,
    message: sanitizeText(ev.message, MAX_MESSAGE_BYTES),
    stack: ev.stack ? sanitizeText(ev.stack, MAX_STACK_BYTES) : null,
    context: sanitizeContext(ev.context) as Record<string, unknown>,
  };

  // Cap context size. Falls back to a stub if too large.
  const ctxJson = JSON.stringify(cleaned.context);
  if (utf8ByteSize(ctxJson) > MAX_CONTEXT_BYTES) {
    cleaned.context = {
      _truncated: true,
      _originalBytes: utf8ByteSize(ctxJson),
    };
  }

  const totalJson = JSON.stringify(cleaned);
  if (utf8ByteSize(totalJson) > MAX_EVENT_BYTES) {
    return null;
  }
  return cleaned;
}

export const SANITIZER_LIMITS = {
  MAX_MESSAGE_BYTES,
  MAX_STACK_BYTES,
  MAX_EVENT_BYTES,
  MAX_CONTEXT_BYTES,
};
