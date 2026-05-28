/**
 * D-P2P Slice 1 (2026-05-28) — in-memory counter for "where did the WO
 * come from this tick?" — `gossipsub` (drained from the libp2p push
 * queue) or `poll` (returned from the HTTP `/work-orders/available`
 * fallback).
 *
 * The counter is a process-local accumulator. The caller (FetchWorkOrdersNode)
 * increments by `pushed.length` for gossipsub hits and by `httpResult.length`
 * for poll fallbacks. The accumulated delta is sent piggyback on the
 * existing `work-order.queue.audit` telemetry event (see
 * `event-builder.ts :: makeWorkOrderQueueAuditEvent`) once per drain
 * pass. Coord-side derives a Prometheus counter from those deltas (see
 * `coordinator/src/application/telemetry/DiscoverySourceMetricSink.ts`).
 *
 * Why a counter and not a per-tick bool: a single `execute()` tick only
 * has ONE source (drain XOR poll, never both), but operators want
 * cumulative ratios over hours/days. The accumulator + emit-as-delta
 * pattern is how the coord-side Prometheus counter ends up monotone.
 *
 * Cardinality discipline (reviewer-lesson P28): `source` is a CLOSED
 * 2-element enum. NEVER widen to include `unknown`, `cache`, etc.
 * Anything beyond gossipsub/poll requires a new event field.
 *
 * Concurrency note (reviewer-lesson P21): Node.js is single-threaded
 * per event-loop tick. `++` on a primitive field is atomic w.r.t.
 * other tasks queued on the same loop, so no explicit lock is needed.
 * Tests assert this by interleaving emits.
 */

export type DiscoverySource = 'gossipsub' | 'poll';

export interface DiscoverySourceCounterSnapshot {
  gossipsub: number;
  poll: number;
}

/**
 * Pure, framework-agnostic accumulator. Lives as a module-level
 * singleton so all call-sites (FetchWorkOrdersNode + tests) see the
 * same instance — DI was overkill given the single producer/consumer.
 */
export class DiscoverySourceCounter {
  private gossipsub = 0;
  private poll = 0;

  /** Increment the counter for `source` by `delta` (default 1). */
  increment(source: DiscoverySource, delta: number = 1): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    if (source === 'gossipsub') {
      this.gossipsub += delta;
      return;
    }
    if (source === 'poll') {
      this.poll += delta;
      return;
    }
    // Exhaustiveness: source is a closed union — TS rejects any
    // other value at compile time. At runtime, ignore silently
    // rather than throw (telemetry must NEVER derail discovery).
  }

  /** Non-destructive read for diagnostics / tests. */
  snapshot(): DiscoverySourceCounterSnapshot {
    return { gossipsub: this.gossipsub, poll: this.poll };
  }

  /**
   * Atomically read AND zero the counter. Caller emits the delta in a
   * single audit event so the coord-side Prometheus counter receives a
   * monotone increment. Returning `null` when both sides are zero lets
   * the caller omit the field from the event payload (saves bytes on
   * the wire — the audit event fires on every tick, even idle ones).
   */
  readAndReset(): DiscoverySourceCounterSnapshot | null {
    const out = this.snapshot();
    if (out.gossipsub === 0 && out.poll === 0) return null;
    this.gossipsub = 0;
    this.poll = 0;
    return out;
  }

  /** Test hook — wipe state between specs without exporting internals. */
  __resetForTests(): void {
    this.gossipsub = 0;
    this.poll = 0;
  }
}

/**
 * Module-level singleton (reviewer-lesson P11/P15 — single source of
 * truth, no DI dup). Exported function so tests can spy via
 * `jest.spyOn(module, 'getDiscoverySourceCounter')` if needed.
 */
const singleton = new DiscoverySourceCounter();

export function getDiscoverySourceCounter(): DiscoverySourceCounter {
  return singleton;
}

/** Test helper — wipes the singleton state. */
export function __resetDiscoverySourceCounterForTests(): void {
  singleton.__resetForTests();
}
