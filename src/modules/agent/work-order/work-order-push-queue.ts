/**
 * WorkOrderPushQueue — local in-memory cache of work orders broadcast over
 * gossipsub on TOPICS.WORK_ORDER_AVAILABLE. Fed by node-runtime's pubsub
 * subscription, drained by the LangGraph work-order agent service at the
 * start of every iteration.
 *
 * Replaces the GET /work-orders/available poll for the common case. The
 * HTTP fetch stays as a safety-net fallback at a much longer interval (5
 * min by default) so a node that missed gossip messages still discovers
 * pending work eventually.
 *
 * Design notes:
 *   - Entries expire after `entryTtlMs` (default 600s, i.e. 10 min — see
 *     D-P2P Slice 0.6 / BUG #5 note below) so a slow loop never accepts an
 *     already-cancelled WO. The accept HTTP call still races against other
 *     nodes — push doesn't change semantics, only discovery.
 *   - `drain()` clears the queue. Each iteration sees fresh items only.
 *   - `wake()` lets a subscriber kick the loop awake without coupling the
 *     queue to the loop's sleep mechanism. The runtime wires a callback on
 *     boot. P21: the callback MUST be idempotent / debounced on the
 *     consumer side because gossipsub fan-out can deliver bursts.
 *
 * D-P2P Slice 0.6 / BUG #5 (2026-05-28) — TTL bumped 60s → 600s.
 *   Production audit on 2026-05-28 showed gossipsub envelopes arriving mid-
 *   iteration (e.g. while a TRAINING WO was executing, ~3 min) expiring
 *   BEFORE the next `drain()` tick because the 60s TTL was shorter than
 *   the iter cycle (training + sleep ~ 3-5 min). Result: pushed WO was
 *   stranded in the local queue and the next iter still fell back to the
 *   HTTP poll path. Invariant from the fix: `entryTtlMs >= max(iter
 *   execution + sleep window)`. With a 5-min default fallback sleep and
 *   ~3-min training executions, 10 min is the comfortable upper bound
 *   that still excludes cancelled WOs. Pair this with the `setWakeCallback`
 *   path now wired in `node-runtime.ts` → in practice the push arrives,
 *   wakes the loop, and is drained in milliseconds; the TTL is the
 *   pathological-case safety net (sleep interrupted by load, kick missed,
 *   etc.).
 */

/**
 * Coordinator-side `WorkOrderResponseDto` shape, plus the timestamp we
 * received it locally for TTL bookkeeping. Field set mirrors
 * `packages/coordinator/src/application/work-orders/work-order.utils.ts ::
 * toResponseDto` so the loop can drive execution without re-fetching.
 */
export interface PushedWorkOrder {
  id: string;
  title: string;
  description?: string;
  type?: string;
  status: string;
  rewardAmount: string;
  requiredCapabilities: string[];
  creatorAddress: string;
  assigneeAddress?: string;
  createdAt: string | number;
  acceptedAt?: string;
  completedAt?: string;
  estimatedDuration?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /**
   * D-P2P Slice 2 (2026-05-28) — monotonic insertion sequence assigned
   * by the coord. Tracked node-side as `lastSeenSeq` so the HTTP
   * fallback can request only the delta (`?since=`). Optional on
   * the wire because legacy pre-slice envelopes may not carry it.
   */
  seq?: number;
  /** Receive timestamp for TTL bookkeeping. */
  receivedAt: number;
}

export class WorkOrderPushQueue {
  private readonly entries = new Map<string, PushedWorkOrder>();
  private wakeCb: (() => void) | null = null;

  /**
   * D-P2P Slice 0.6 (2026-05-28) — default raised 60_000 → 600_000.
   * See file header note. Tests that need the old fast-expiry behaviour
   * pass a small value explicitly (the previous 50ms expiry test still
   * does so).
   */
  constructor(private readonly entryTtlMs: number = 600_000) {}

  /** Register the loop's wake-up hook. Called once on boot. */
  setWakeCallback(cb: () => void): void {
    this.wakeCb = cb;
  }

  push(wo: Omit<PushedWorkOrder, 'receivedAt'>): void {
    this.entries.set(wo.id, { ...wo, receivedAt: Date.now() });
    // Fire and forget — the loop will pick the entry up on its next tick
    // even if the wake fails.
    try {
      this.wakeCb?.();
    } catch {
      /* wake callback exceptions must never bubble through gossip handlers */
    }
  }

  /**
   * Re-insert an entry preserving its ORIGINAL `receivedAt` so the TTL
   * window is not refreshed. Used by the loop to put back work orders
   * that were drained but not yet attempted (e.g. capacity hit mid-batch).
   *
   * Refreshing the timestamp via `push()` would let a WO that loses the
   * capacity race repeatedly live forever in the queue — bypassing the
   * TTL safety net documented at the top of this file (10 min default
   * since D-P2P Slice 0.6).
   *
   * Does NOT fire `wakeCb`: the caller is mid-iteration and the loop is
   * already awake; waking it again would just spin the timer wheel.
   */
  requeue(entry: PushedWorkOrder): void {
    this.entries.set(entry.id, entry);
  }

  /** Returns all unexpired entries and clears the queue. */
  drain(): PushedWorkOrder[] {
    const now = Date.now();
    const out: PushedWorkOrder[] = [];
    for (const [id, entry] of this.entries) {
      if (now - entry.receivedAt > this.entryTtlMs) continue;
      out.push(entry);
      this.entries.delete(id);
    }
    // Sweep stale entries that survived the loop above (none should, but
    // belt-and-suspenders against clock drift).
    for (const [id, entry] of this.entries) {
      if (now - entry.receivedAt > this.entryTtlMs) this.entries.delete(id);
    }
    return out;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
