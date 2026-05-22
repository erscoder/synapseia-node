/**
 * BackpressureService — limits concurrent in-flight work orders to prevent
 * resource starvation. Guards both the legacy loop and LangGraph paths.
 *
 * Slice 9 (Plan B, 2026-05-17) — per-class slot buckets
 * ----------------------------------------------------
 * The original implementation kept a single global counter
 * (`MAX_CONCURRENT_WORK_ORDERS`, default 2). On memory-constrained
 * pods (pod A40, cgroup 46.6 GB) that is BOTH too loose for heavy
 * training (one DiLoCo run alone can be >25 GB peak) AND too tight
 * for cheap workloads (CPU inference / docking can run two-up without
 * issue). Per-class buckets let a single env split the budget:
 *
 *   HEAVY (default 1 slot): TRAINING, DILOCO_TRAINING, LORA_TRAINING
 *   LIGHT (default 2 slots): CPU_INFERENCE, GPU_INFERENCE,
 *                            MOLECULAR_DOCKING, RESEARCH,
 *                            LORA_VALIDATION
 *
 * A node can therefore safely run 1 DiLoCo + 2 RESEARCH inferences
 * concurrently without the heavy run starving everything else, while
 * still preventing two heavy spawns from racing for the same
 * Qwen2.5-7B page-cache window.
 *
 * Legacy env behavior — back-compat
 * ---------------------------------
 * If BOTH `MAX_HEAVY_WORK_ORDERS` AND `MAX_LIGHT_WORK_ORDERS` are
 * unset AND legacy `MAX_CONCURRENT_WORK_ORDERS` IS set, the legacy
 * value is interpreted as `MAX_LIGHT_WORK_ORDERS` only, with HEAVY
 * pinned to the safer default of 1. A WARN is logged so an operator
 * who previously raised `MAX_CONCURRENT_WORK_ORDERS=3` to handle a
 * burst of inference WOs does not accidentally raise heavy
 * concurrency to 3 and OOM the pod. To opt back into "global single
 * bucket" semantics they must explicitly set both env vars.
 *
 * Configuration
 * -------------
 *   MAX_HEAVY_WORK_ORDERS (default 1)
 *   MAX_LIGHT_WORK_ORDERS (default 2)
 *   MAX_CONCURRENT_WORK_ORDERS — legacy, read only when neither of
 *     the above is set; mapped to LIGHT only.
 *
 * Reviewer-lessons applied
 * ------------------------
 *   P2 fail-closed: unknown/missing `type` on acquire falls back to
 *     the LIGHT class (the smaller-footprint bucket from the heavy
 *     spawn's perspective — a misclassified light WO never consumes
 *     a heavy slot and OOMs the pod). The opposite default would
 *     leak heavy-class concurrency on un-typed acceptances.
 *   P10 docblocks match behavior: the surface API (`canAccept`,
 *     `acquire`, `release`) keeps the same signatures; `acquire` now
 *     takes an optional `type` second arg. Idempotency rule
 *     preserved: re-acquiring the same WO id is a no-op success
 *     regardless of the type passed (the original class wins).
 *   P28 constant bump → grep callers: only one production caller
 *     (`accept-wo.ts`) was updated to pass `selectedWorkOrder.type`.
 */

import { Injectable } from '@nestjs/common';
import logger from '../../../utils/logger';

type SlotClass = 'HEAVY' | 'LIGHT';

/**
 * Map a WorkOrder type string to its concurrency slot class.
 * Exported for unit testing — the prod path always goes through
 * `acquire(id, type)`.
 */
export function classifyWorkOrderSlot(
  type: string | undefined | null,
): SlotClass {
  if (!type) return 'LIGHT';
  const t = String(type).toUpperCase();
  if (t === 'TRAINING' || t === 'DILOCO_TRAINING' || t === 'LORA_TRAINING') {
    return 'HEAVY';
  }
  return 'LIGHT';
}

@Injectable()
export class BackpressureService {
  private readonly maxByClass: Record<SlotClass, number>;
  private readonly inFlightByClass: Record<SlotClass, Set<string>> = {
    HEAVY: new Set(),
    LIGHT: new Set(),
  };
  /**
   * Track the class each acquired WO id landed in so `release(id)`
   * can return the slot to the correct bucket regardless of whether
   * the caller still knows the WO's type at release time. Critical
   * because LangGraph release paths (success / failure / timeout) do
   * NOT all carry the type field.
   */
  private readonly idToClass = new Map<string, SlotClass>();

  /**
   * Drain latch. When true, `acquire`/`canAccept` refuse NEW HEAVY
   * (training-class) work so an in-progress self-update can reach a
   * confirmed-idle HEAVY window before it restarts the process. Set by
   * `UpdateManager` immediately before it starts the npm install (which
   * can take minutes), and cleared if the update aborts. LIGHT work is
   * unaffected — only HEAVY work would be killed by a restart, and a
   * HEAVY slot frees up far less often, so we must stop new HEAVY work
   * from sneaking in during the install→restart window (the idle-gate
   * race). Already-acquired HEAVY slots are NOT released here; the
   * manager re-confirms `getInFlightByClass('HEAVY') === 0` right before
   * exit and aborts the restart if any HEAVY WO is still active.
   */
  private draining = false;

  constructor() {
    const heavyEnv = process.env.MAX_HEAVY_WORK_ORDERS;
    const lightEnv = process.env.MAX_LIGHT_WORK_ORDERS;
    const legacyEnv = process.env.MAX_CONCURRENT_WORK_ORDERS;

    let heavy: number;
    let light: number;

    if (
      heavyEnv === undefined &&
      lightEnv === undefined &&
      legacyEnv !== undefined
    ) {
      const legacy = parseInt(legacyEnv, 10);
      if (Number.isNaN(legacy) || legacy < 1) {
        throw new Error(
          `MAX_CONCURRENT_WORK_ORDERS must be >= 1, got ${legacyEnv}`,
        );
      }
      heavy = 1;
      light = legacy;
      logger.warn(
        `[Backpressure] Legacy MAX_CONCURRENT_WORK_ORDERS=${legacy} detected — ` +
          `interpreting as MAX_LIGHT_WORK_ORDERS=${legacy} only ` +
          `(HEAVY pinned to safer default 1). Set MAX_HEAVY_WORK_ORDERS and ` +
          `MAX_LIGHT_WORK_ORDERS explicitly to silence this warning.`,
      );
    } else {
      heavy = parseInt(heavyEnv ?? '1', 10);
      light = parseInt(lightEnv ?? '2', 10);
    }

    if (Number.isNaN(heavy) || heavy < 1) {
      throw new Error(
        `MAX_HEAVY_WORK_ORDERS must be >= 1, got ${heavyEnv ?? '(unset)'}`,
      );
    }
    if (Number.isNaN(light) || light < 1) {
      throw new Error(
        `MAX_LIGHT_WORK_ORDERS must be >= 1, got ${lightEnv ?? '(unset)'}`,
      );
    }

    this.maxByClass = { HEAVY: heavy, LIGHT: light };
    logger.log(
      `[Backpressure] Initialized with HEAVY=${heavy}, LIGHT=${light} concurrent slots`,
    );
  }

  /**
   * Returns true if the node can accept another work order of the
   * given class. When `type` is omitted defaults to LIGHT (the more
   * commonly polled class — RESEARCH / inference loops). HEAVY full
   * does NOT block LIGHT acceptance and vice versa.
   */
  canAccept(type?: string | null): boolean {
    const cls = classifyWorkOrderSlot(type);
    // Drain gate: while a self-update is staging, refuse NEW HEAVY work.
    if (this.draining && cls === 'HEAVY') return false;
    return this.inFlightByClass[cls].size < this.maxByClass[cls];
  }

  /**
   * Try to acquire a slot for the given work order.
   * Returns true if the slot was acquired, false if the target class
   * is at capacity. Idempotent: acquiring the same ID twice is a
   * no-op (returns true) and the original class assignment wins —
   * the second `type` arg is ignored.
   *
   * `type` may be omitted; defaults to LIGHT (fail-safe per P2 — a
   * heavy WO without a known type should never silently consume a
   * heavy slot, but a light WO without a known type is harmless).
   */
  acquire(workOrderId: string, type?: string | null): boolean {
    if (this.idToClass.has(workOrderId)) {
      return true;
    }
    const cls = classifyWorkOrderSlot(type);
    // Drain gate: while a self-update is staging, refuse NEW HEAVY work
    // so the install→restart window cannot kill a training WO accepted
    // after the idle-gate check. Idempotent re-acquire above is allowed
    // (the WO is already in flight, not new). LIGHT is never gated.
    if (this.draining && cls === 'HEAVY') {
      logger.info(
        `[Backpressure] Rejected WO ${workOrderId} (HEAVY) — node draining for self-update`,
      );
      return false;
    }
    const bucket = this.inFlightByClass[cls];
    const limit = this.maxByClass[cls];
    if (bucket.size >= limit) {
      logger.info(
        `[Backpressure] Rejected WO ${workOrderId} (${cls}) — at capacity ` +
          `(${bucket.size}/${limit})`,
      );
      return false;
    }
    bucket.add(workOrderId);
    this.idToClass.set(workOrderId, cls);
    logger.log(
      `[Backpressure] Acquired ${cls} slot for WO ${workOrderId} ` +
        `(${bucket.size}/${limit})`,
    );
    return true;
  }

  /**
   * Release the slot for a completed/failed work order. Returns the
   * slot to the bucket the WO was originally acquired into,
   * regardless of whether the caller passes the type at release time
   * (which is impractical from generic LangGraph error paths).
   */
  release(workOrderId: string): void {
    const cls = this.idToClass.get(workOrderId);
    if (!cls) return; // not tracked
    if (this.inFlightByClass[cls].delete(workOrderId)) {
      this.idToClass.delete(workOrderId);
      logger.log(
        `[Backpressure] Released ${cls} slot for WO ${workOrderId} ` +
          `(${this.inFlightByClass[cls].size}/${this.maxByClass[cls]})`,
      );
    }
  }

  /** Current number of in-flight work orders across all classes. */
  getInFlight(): number {
    return this.inFlightByClass.HEAVY.size + this.inFlightByClass.LIGHT.size;
  }

  /** Current number of in-flight work orders of the given class. */
  getInFlightByClass(cls: SlotClass): number {
    return this.inFlightByClass[cls].size;
  }

  /**
   * Toggle the drain latch (see the `draining` field). `UpdateManager`
   * sets it before staging a self-update and clears it on any abort so
   * a deferred/failed update never permanently blocks HEAVY work.
   */
  setDraining(draining: boolean): void {
    this.draining = draining;
    logger.log(
      `[Backpressure] draining=${draining} (HEAVY acceptance ${draining ? 'paused' : 'resumed'})`,
    );
  }

  /** Whether the node is currently draining HEAVY work for a self-update. */
  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Total allowed concurrent work orders across all classes. Kept
   * for back-compat with operators / dashboards that inspect a
   * single number; prefer `getMaxByClass` for per-class triage.
   */
  getMaxConcurrent(): number {
    return this.maxByClass.HEAVY + this.maxByClass.LIGHT;
  }

  /** Maximum allowed concurrent work orders for the given class. */
  getMaxByClass(cls: SlotClass): number {
    return this.maxByClass[cls];
  }

  /** Returns the set of in-flight work order IDs (snapshot, all classes). */
  getInFlightIds(): ReadonlySet<string> {
    return new Set([
      ...this.inFlightByClass.HEAVY,
      ...this.inFlightByClass.LIGHT,
    ]);
  }
}
