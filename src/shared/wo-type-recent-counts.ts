/**
 * D-P2P fairness (2026-05-31) — per-type SLIDING-WINDOW recent-work
 * counter for homogeneous work-mix selection.
 *
 * ROOT CAUSE this supports: a node that discovers a homogeneous flood of
 * one WO type (TRAINING gossipsub-pushed every minute) would, with a
 * naive FIFO/first-available pick, never rotate onto the rarer poll-only
 * types (RESEARCH, *_INFERENCE). The fetch node consults this counter to
 * give SOFT least-recently-done priority to the type with the lowest
 * recent acceptance count, so the node stays homogeneous across types.
 *
 * Design:
 *  - In-memory ONLY. "Recent work" must NOT be lifetime — a lifetime
 *    counter would permanently skew against TRAINING (huge historical
 *    head start) and starve it forever. A fresh process starts with an
 *    empty window (every type ties at 0), which is the desired neutral
 *    boot state.
 *  - SLIDING TIME WINDOW: each acceptance records `(type, timestampMs)`.
 *    `countFor(type)` counts only records within the last `windowMs`
 *    (default 10 min). Older records are pruned lazily on read/record so
 *    the structure stays bounded without a timer.
 *  - No decay weighting beyond the hard window edge — a record either
 *    counts (inside window) or it doesn't (outside). This is simpler than
 *    exponential decay and sufficient for soft rotation: the window edge
 *    IS the decay. T (window) is the only knob.
 *
 * Concurrency: single-threaded Node event loop; no locking needed. The
 * fetch node is the sole consumer.
 *
 * P22: pure in-memory, no I/O, cannot throw on persistence — degrades to
 * "everything ties at 0" only if something upstream stops calling
 * `record()`, which is the safe (neutral) failure mode.
 */

/** Default sliding-window span. ~one minute longer than the push-queue
 * TTL (600s) so a type that just churned a batch stays "recently done"
 * across the next discovery tick rather than instantly resetting. */
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

export class WoTypeRecentCounts {
  /** Append-only-ish ring of acceptance timestamps keyed by WO type.
   * Pruned lazily; never grows unbounded because prune drops anything
   * older than the window on every record/read. */
  private readonly records = new Map<string, number[]>();

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  /**
   * Record an acceptance/completion of `type` at `now` (default
   * Date.now()). `undefined`/empty type is ignored (untyped WOs do not
   * participate in fairness rotation).
   */
  record(type: string | undefined, now: number = Date.now()): void {
    if (!type) return;
    const arr = this.records.get(type) ?? [];
    arr.push(now);
    this.prune(arr, now);
    this.records.set(type, arr);
  }

  /**
   * Recent count for `type` within the sliding window. Prunes expired
   * records as a side effect so repeated reads stay O(live records).
   */
  countFor(type: string | undefined, now: number = Date.now()): number {
    if (!type) return 0;
    const arr = this.records.get(type);
    if (!arr || arr.length === 0) return 0;
    this.prune(arr, now);
    if (arr.length === 0) {
      this.records.delete(type);
      return 0;
    }
    return arr.length;
  }

  /** Drop in place every timestamp older than the window edge. */
  private prune(arr: number[], now: number): void {
    const edge = now - this.windowMs;
    // Records are pushed in ascending time order, so the expired ones are
    // a prefix — splice them off in one pass.
    let firstLive = 0;
    while (firstLive < arr.length && arr[firstLive]! <= edge) firstLive++;
    if (firstLive > 0) arr.splice(0, firstLive);
  }

  /** Test-only — wipe all window state. */
  reset(): void {
    this.records.clear();
  }
}

/** Process-wide singleton; the fetch node is the sole consumer. */
let singleton: WoTypeRecentCounts | null = null;

export function getWoTypeRecentCounts(): WoTypeRecentCounts {
  if (!singleton) singleton = new WoTypeRecentCounts();
  return singleton;
}

/** Test-only — reset the singleton so specs start from a clean window. */
export function __resetWoTypeRecentCountsForTests(): void {
  singleton = null;
}
