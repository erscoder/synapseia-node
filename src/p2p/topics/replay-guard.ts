/**
 * replay-guard.ts — bounded, opt-in replay guard for coordinator-signed
 * gossip envelopes.
 *
 * The freshness window already rejects any envelope older than
 * `freshnessWindowSec` (default 60s). This guard closes the remaining gap: a
 * captured-and-replayed envelope re-injected WITHIN the freshness window. It
 * records each accepted signature with an expiry equal to the freshness
 * window and rejects a signature it has already seen before that expiry.
 *
 * Bounded memory: entries are pruned on expiry, plus an opportunistic full
 * sweep once the map grows past `REPLAY_GUARD_PRUNE_THRESHOLD` — mirroring the
 * `PeerQueryRateLimiter` prune pattern in
 * `packages/node/src/p2p/protocols/kg-shard-query.ts` so an attacker spraying
 * distinct signatures cannot grow the map without bound.
 *
 * One guard instance is wired PER TOPIC at the dispatch site (node-runtime),
 * so a WORK_ORDER_AVAILABLE signature and a WORK_ORDER_ASSIGNED signature
 * never share a seen-set (they are distinct topics with distinct guards).
 */

/**
 * Above this many tracked signatures, sweep every expired entry so the map
 * cannot grow unbounded by an attacker spraying distinct (already-rejected)
 * signatures. Same memory-DoS defence class as the kg-shard-query rate
 * limiter prune.
 */
export const REPLAY_GUARD_PRUNE_THRESHOLD = 4096;

export class ReplayGuard {
  /** Map<base64 signature, expiry epoch-ms>. */
  private readonly seen = new Map<string, number>();

  /**
   * @param freshnessWindowSec TTL for each recorded signature, in seconds —
   *        MUST equal the handler's freshness window so a signature is
   *        remembered exactly as long as it could still pass the freshness
   *        check. Once it would be rejected as stale anyway, the entry is
   *        free to expire.
   */
  constructor(private readonly freshnessWindowSec: number) {}

  /**
   * Record `sigBase64` and report whether it was seen before (within its
   * still-live TTL). Returns:
   *   - `false` the FIRST time a signature is presented (records it),
   *   - `true`  on any subsequent presentation before the entry expires.
   *
   * An entry whose TTL has lapsed is treated as never-seen (and refreshed),
   * matching the freshness window: a signature old enough to have expired
   * here would already be rejected as stale upstream.
   */
  seenBefore(sigBase64: string, nowMs: number): boolean {
    const ttlMs = this.freshnessWindowSec * 1000;

    // Opportunistic full prune once the map grows past the threshold: drop
    // every entry whose expiry has lapsed. Keeps the "bounded" invariant real
    // rather than relying only on per-key lazy expiry.
    if (this.seen.size > REPLAY_GUARD_PRUNE_THRESHOLD) {
      for (const [key, expiry] of this.seen) {
        if (expiry <= nowMs) this.seen.delete(key);
      }
    }

    const expiry = this.seen.get(sigBase64);
    if (expiry !== undefined && expiry > nowMs) {
      // Seen before and still within TTL → replay.
      return true;
    }

    // First sighting (or a lapsed entry) → (re)record and accept.
    this.seen.set(sigBase64, nowMs + ttlMs);
    return false;
  }
}
