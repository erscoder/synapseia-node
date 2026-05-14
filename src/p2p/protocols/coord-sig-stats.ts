/**
 * coord-sig-stats.ts — rolling-window stats + rate-limited diagnostics
 * for coordinator Ed25519 envelope verification (WORK_ORDER_AVAILABLE,
 * EVALUATION_ASSIGNMENTS, KG_SHARD_OWNERSHIP, KG_QUERY_REDIRECT).
 *
 * Two responsibilities:
 *   1. Suppress flood — emit at most one WARN per (topic, sig-prefix)
 *      every 60s with a count of how many messages from that source
 *      were rejected since the last WARN.
 *   2. Detect "stale CLI" — if more than 50% of the last 20 coord
 *      envelopes failed verification, emit one ERROR pointing the
 *      operator at the upgrade path. Reset after the ERROR fires so
 *      we do not spam on every subsequent failure.
 *
 * Why this exists: the coord pubkey is a hardcoded trust anchor (see
 * `coordinator-pubkey.ts`). Re-fetching dynamically would break the
 * trust-anchor model — rotation is a release ceremony. But when the
 * coord rotates and an operator runs a stale CLI, the node spews
 * `[WO-Verify] invalid signature` per gossip burst with no actionable
 * signal. This module turns that noise into a single, actionable
 * upgrade-CLI ERROR.
 *
 * Design constraints:
 *   - Zero runtime deps (stdlib only).
 *   - Bounded memory: prune entries older than 2 × WARN_THROTTLE_MS
 *     inline in `shouldEmitWarn`.
 *   - Crisis ERROR fires at most once per process (latch + reset
 *     window so we do not re-arm immediately).
 *   - Pure functions where possible; module-level state confined to
 *     this file and resettable via `resetStats()` for tests.
 */
import { COORDINATOR_PUBKEY_BASE58 } from './coordinator-pubkey';

/** Throttle window — at most one WARN per (topic, sig-prefix) in this window. */
export const WARN_THROTTLE_MS = 60_000;
/** Convenience: same window in seconds, for log strings. */
export const WARN_THROTTLE_SECONDS = WARN_THROTTLE_MS / 1000;
/** Rolling window size for crisis detection. */
export const CRISIS_WINDOW = 20;
/** Fail-ratio threshold to fire the crisis ERROR. */
export const CRISIS_FAIL_RATIO = 0.5;
/** First 8 chars of the hardcoded coord pubkey — included in WARN/ERROR
 *  so operators can eyeball which trust anchor this CLI was built with. */
export const EXPECTED_COORD_PUBKEY_PREFIX = COORDINATOR_PUBKEY_BASE58.slice(0, 8);

interface ThrottleEntry {
  lastEmitMs: number;
  suppressedSince: number;
}

const throttleMap = new Map<string, ThrottleEntry>();
const rollingWindow: boolean[] = []; // true = ok, false = fail
let crisisFired = false;

function fingerprint(topic: string, sigPrefix: string): string {
  return `${topic}:${sigPrefix}`;
}

/**
 * Record a single verify outcome in the rolling window used by the
 * crisis detector. Does NOT touch throttle state — that is handled by
 * `shouldEmitWarn`.
 */
export function recordVerify(
  _topic: string,
  _sigPrefix: string,
  ok: boolean,
): void {
  rollingWindow.push(ok);
  if (rollingWindow.length > CRISIS_WINDOW) {
    rollingWindow.shift();
  }
}

/**
 * Determine whether a WARN should be emitted for this (topic, sigPrefix)
 * right now. Returns the suppression count accumulated since the last
 * emit (so the caller can include it in the log line).
 *
 * Side effects:
 *   - If `emit === true`, the throttle entry's `lastEmitMs` is updated
 *     to `now` and `suppressedSince` reset to 0.
 *   - If `emit === false`, the throttle entry's `suppressedSince` is
 *     incremented by 1.
 *   - Prunes entries whose `lastEmitMs` is older than
 *     `2 * WARN_THROTTLE_MS` to bound memory.
 */
export function shouldEmitWarn(
  topic: string,
  sigPrefix: string,
  now: number = Date.now(),
): { emit: boolean; suppressed: number } {
  // Inline prune — cheap (Map iteration over a tiny set).
  const pruneCutoff = now - 2 * WARN_THROTTLE_MS;
  for (const [key, entry] of throttleMap) {
    if (entry.lastEmitMs < pruneCutoff) {
      throttleMap.delete(key);
    }
  }

  const key = fingerprint(topic, sigPrefix);
  const existing = throttleMap.get(key);

  if (!existing) {
    throttleMap.set(key, { lastEmitMs: now, suppressedSince: 0 });
    return { emit: true, suppressed: 0 };
  }

  if (now - existing.lastEmitMs >= WARN_THROTTLE_MS) {
    const suppressed = existing.suppressedSince;
    existing.lastEmitMs = now;
    existing.suppressedSince = 0;
    return { emit: true, suppressed };
  }

  existing.suppressedSince += 1;
  return { emit: false, suppressed: existing.suppressedSince };
}

/**
 * If the rolling window contains at least `CRISIS_WINDOW` samples AND
 * more than `CRISIS_FAIL_RATIO` of them failed, return the operator-
 * facing ERROR string ONCE. Subsequent calls return `null` until
 * `resetStats()` is invoked.
 */
export function checkMismatchCrisis(_now: number = Date.now()): string | null {
  if (crisisFired) return null;
  if (rollingWindow.length < CRISIS_WINDOW) return null;

  const fails = rollingWindow.reduce((n, ok) => n + (ok ? 0 : 1), 0);
  const ratio = fails / rollingWindow.length;
  if (ratio <= CRISIS_FAIL_RATIO) return null;

  crisisFired = true;
  return (
    `[Coord-Verify] >50% of last ${CRISIS_WINDOW} coord envelopes failed ` +
    `signature verification — your CLI's hardcoded coord pubkey may be ` +
    `stale. Upgrade @synapseia-network/node to the latest version ` +
    `(npm install -g @synapseia-network/node@latest) and restart this ` +
    `node. Expected pubkey prefix: ${EXPECTED_COORD_PUBKEY_PREFIX}.`
  );
}

/** Test-only: clear all internal state. */
export function resetStats(): void {
  throttleMap.clear();
  rollingWindow.length = 0;
  crisisFired = false;
}
