import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { BackpressureService } from '../../work-order/backpressure.service';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { canLocallyAcceptWorkOrder } from '../../work-order/wo-type-to-cap';
import { getCurrentCapabilities } from '../../../heartbeat/heartbeat';
import type { AgentState, WorkOrder } from '../state';
import logger from '../../../../utils/logger';
import { isChatInferenceActive } from '../../../inference/chat-inference-state';
import { getWoFailureCountStore, WoFailureCountStore } from '../../../../shared/wo-failure-counts';
import {
  getGlobalTelemetryClient,
  makeWorkOrderQueueAuditEvent,
  type HwFingerprint,
} from '../../../telemetry';

const RESEARCH_COOLDOWN_MS = parseInt(process.env.RESEARCH_COOLDOWN_MS ?? String(5 * 60 * 1000), 10);
// Training WOs (CPU/GPU/DiLoCo) are multi-submission: the coordinator ranks by
// MAX qualityScore per peer in the micros table, so re-training with a new
// mutation improves the node's projected reward. Apply a short cooldown after
// each submission to avoid tight re-accept loops while the round stays open.
const TRAINING_COOLDOWN_MS = parseInt(process.env.TRAINING_COOLDOWN_MS ?? String(60 * 1000), 10);

@Injectable()
export class FetchWorkOrdersNode {
  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly execution: WorkOrderExecutionHelper,
    private readonly backpressure: BackpressureService,
  ) {}


  private readonly researchCooldowns = new Map<string, number>();
  private readonly trainingCooldowns = new Map<string, number>();
  private readonly completedWorkOrderIds = new Set<string>();
  /**
   * Bug 20 v3 (2026-05-18) — consecutive-timeout counter store. Injectable
   * for tests via the `failureStore` setter; production uses the
   * singleton backed by `~/.synapseia/wo-failure-counts.json`.
   */
  private failureStore: WoFailureCountStore = getWoFailureCountStore();
  /** Test-only injection point — reset cache between tests. */
  __setFailureStoreForTests(store: WoFailureCountStore): void {
    this.failureStore = store;
  }

  /**
   * Bug 20 v3 (2026-05-18) — public so SubmitResultNode (and any other
   * post-execution caller) can mark a WO as timed-out. Increments the
   * persistent counter; after the cap, `shouldSkip` returns true and the
   * pre-fetch filter rejects this WO on subsequent polls.
   */
  markFailedTimeout(workOrderId: string, reason: string): { count: number; cappedNow: boolean } {
    return this.failureStore.markFailedTimeout(workOrderId, reason);
  }

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    // F-node-012 (P22) — drain-cycle audit counters. Emitted via
    // `makeWorkOrderQueueAuditEvent` at the end of every execute() pass
    // (including early-return branches) so the coord-side telemetry sink
    // can detect silent discard / starvation. See P22 reviewer-lesson.
    let rejectedByCooldown = 0;
    let rejectedByCap = 0;
    let accepted = 0;
    let drained = 0;

    // Backpressure: if at capacity, skip polling entirely. Expected steady-
    // state behaviour for a busy node — log at info, not warn.
    if (!this.backpressure.canAccept()) {
      logger.info(
        `[Backpressure] At capacity (${this.backpressure.getInFlight()}/${this.backpressure.getMaxConcurrent()}) — skipping poll`,
      );
      this.emitQueueAudit({ drained, requeued: 0, accepted, rejectedByCooldown, rejectedByCap: 1 });
      return { availableWorkOrders: [] };
    }

    const { coordinatorUrl, peerId, capabilities, rejectedWorkOrderIds = [] } = state;
    logger.log(' Polling for available work orders...');

    const workOrders = await this.coordinator.fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
    drained = workOrders.length;
    if (workOrders.length === 0) {
      logger.log(' No work orders available');
      this.emitQueueAudit({ drained, requeued: 0, accepted, rejectedByCooldown, rejectedByCap });
      return { availableWorkOrders: [] };
    }

    logger.log(` Found ${workOrders.length} available work order(s)`);
    const now = Date.now();

    // Bug 25 (2026-05-17) — LIVE heartbeat caps are AUTHORITATIVE.
    //
    // History:
    //  - Bug 22 (2026-05-17) introduced an intersection
    //    `state.capabilities ∩ live` to strip caps that the heartbeat
    //    had removed under memory pressure (the agent state cached
    //    `capabilities` at boot and never refreshed).
    //  - Bug 25 (same day, regression) — the intersection ALSO silently
    //    dropped caps that the heartbeat ADDED async after boot. The
    //    sync boot-time `determineCapabilities()` only emits CPU/GPU
    //    base caps; async probes (LoRA stack, DiLoCo model markers,
    //    docking marker file, container/cgroup gate) add caps like
    //    `diloco_training`, `lora_training`, `lora_generation`,
    //    `docking` later in the first heartbeat tick. Those caps live
    //    in `live` but never in `state.capabilities` → intersection
    //    erased them → node visibly held the cap (coord drift logs
    //    `added=[diloco_training]`) yet rejected every matching WO with
    //    "cap not in current caps".
    //
    // Fix: trust live. The heartbeat snapshot is the post-filter,
    // post-hysteresis "what coord knows about me right now" view — it
    // already encodes both removals (memory pressure stripped a cap)
    // AND additions (async probe finished, marker file appeared). The
    // boot snapshot was always a strict subset of the steady-state
    // truth, so the intersection was upper-bounded by the wrong set.
    //
    // Pre-primer fallback: `getCurrentCapabilities()` returns `[]`
    // until the first heartbeat tick lands `lastAnnouncedCapabilities`.
    // During that window we fall back to `state.capabilities` so a
    // clean boot can still poll. Defense-in-depth: `accept-wo.ts` calls
    // `canLocallyAcceptWorkOrder` against the same live snapshot, which
    // fails closed when `currentCaps` is empty (wo-type-to-cap.ts:100)
    // — so even if a WO slips past this pre-fetch filter pre-primer,
    // the final accept gate will reject it.
    //
    // Out of scope: refreshing `state.capabilities` itself when the
    // heartbeat sheds/adds caps. The state field is now effectively
    // legacy (only used as the pre-primer fallback). See architectural
    // note in spec.
    const live = getCurrentCapabilities();
    const effectiveCaps = live.length > 0 ? Array.from(live) : (capabilities ?? []);
    const pending = workOrders.filter((wo: WorkOrder) => {
      // Capability guard: the coordinator should already filter by registered
      // capabilities, but defend against mismatches (e.g. a coordinator that
      // trusts self-reported caps, a WO whose requirements were tightened
      // after the node's heartbeat, or — Bug 22 — a cap stripped from
      // the live heartbeat AFTER the agent state was seeded at boot).
      // Without this guard the node wastes an HTTP round-trip and logs
      // "likely race condition" on the inevitable 400 from /accept,
      // OR — worse — coord rubber-stamps and the node OOMs trying to
      // execute a WO whose required cap was stripped under memory
      // pressure.
      const gate = canLocallyAcceptWorkOrder(wo, effectiveCaps);
      if (!gate.ok) {
        logger.log(` WO "${wo.title}" skipped: ${gate.reason}`);
        return false;
      }
      // Skip work orders already rejected by economic evaluation
      if (rejectedWorkOrderIds.includes(wo.id)) {
        logger.log(` WO "${wo.title}" rejected by economics — skipping`);
        return false;
      }
      // Bug 20 v3 (2026-05-18) — consecutive-timeout skip. After N
      // timeouts on the same WO id (default 2), block locally. Coord may
      // keep redispatching; this pod stops burning slots on a WO whose
      // ligand is intrinsically too expensive for our obabel+RDKit
      // toolchain. P30 reviewer-lesson — TTL (default 24h) prunes the
      // entry so a fixed pod (RDKit installed, obabel upgraded)
      // re-acquires the WO on its own without manual reset.
      if (this.failureStore.shouldSkip(wo.id)) {
        logger.info(
          `[WoLocalSkip] WO "${wo.title}" (id=${wo.id}) skipped: consecutive_timeouts reached cap`,
        );
        return false;
      }
      if (this.execution.isResearchWorkOrder(wo)) {
        const cooldownUntil = this.researchCooldowns.get(wo.id);
        if (cooldownUntil && now < cooldownUntil) {
          const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
          logger.log(` Research WO "${wo.title}" on cooldown — ${remainingSec}s remaining`);
          rejectedByCooldown++;
          return false;
        }
        return true;
      }
      if (this.execution.isTrainingWorkOrder(wo) || this.execution.isDiLoCoWorkOrder(wo)) {
        // Mutex: if the node is currently servicing an inbound chat
        // inference, refuse new TRAINING/DILOCO WOs. They share CPU with the
        // LLM and push chat past the coordinator's stream timeout.
        if (isChatInferenceActive()) {
          logger.log(` Training WO "${wo.title}" deferred — chat inference in progress`);
          rejectedByCap++;
          return false;
        }
        // Training WOs are retry-friendly: ranking uses best score per peer,
        // so a second attempt with a new mutation can promote the node. Apply
        // a cooldown instead of permanent exclusion.
        const cooldownUntil = this.trainingCooldowns.get(wo.id);
        if (cooldownUntil && now < cooldownUntil) {
          const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
          logger.log(` Training WO "${wo.title}" on cooldown — ${remainingSec}s remaining`);
          rejectedByCooldown++;
          return false;
        }
        return true;
      }
      return !this.completedWorkOrderIds.has(wo.id);
    });

    accepted = pending.length;
    if (pending.length < workOrders.length) {
      logger.log(` Skipping ${workOrders.length - pending.length} WO(s) — ${pending.length} remaining`);
    }
    if (pending.length === 0) {
      logger.log(' All work orders skipped (completed / cooldown / rejected by economics) — waiting');
      this.emitQueueAudit({ drained, requeued: 0, accepted, rejectedByCooldown, rejectedByCap });
      return { availableWorkOrders: [] };
    }

    this.emitQueueAudit({ drained, requeued: 0, accepted, rejectedByCooldown, rejectedByCap });
    return { availableWorkOrders: pending };
  }

  /**
   * F-node-012 (P22) — emit per-execute() drain audit. Best-effort:
   * any failure in the telemetry pipeline (no global client yet, missing
   * hwFingerprint, ring overflow) must never derail WO polling.
   */
  private emitQueueAudit(counts: {
    drained: number;
    requeued: number;
    accepted: number;
    rejectedByCooldown: number;
    rejectedByCap: number;
  }): void {
    try {
      const client = getGlobalTelemetryClient();
      if (!client) return;
      const hw: HwFingerprint = {
        os: process.platform,
        arch: process.arch,
      };
      client.emit(makeWorkOrderQueueAuditEvent(hw, counts));
    } catch {
      /* telemetry must never throw past the fetch-WO node */
    }
  }

  markCompleted(workOrder: WorkOrder): void {
    // Re-entry policy by WO type:
    //  - RESEARCH: long cooldown (5 min default) — nodes re-analyse with new
    //    hyperparams, but not back-to-back on the same paper.
    //  - TRAINING / DILOCO_TRAINING: short cooldown (60s default) — nodes
    //    retry with fresh mutations; ranker takes MAX score per peer.
    //  - everything else (inference, etc.): permanent exclusion.
    // Bug 20 v3 (2026-05-18) — a successful completion clears the
    // timeout-failure counter for this WO so a flapping ligand whose
    // first attempt timed out (med tier) but second succeeded (fast or
    // RDKit fallback) doesn't carry penalty across runs. P30
    // reviewer-lesson: don't strand transient state forever.
    this.failureStore.clear(workOrder.id);
    if (this.execution.isResearchWorkOrder(workOrder)) {
      this.researchCooldowns.set(workOrder.id, Date.now() + RESEARCH_COOLDOWN_MS);
      return;
    }
    if (this.execution.isTrainingWorkOrder(workOrder) || this.execution.isDiLoCoWorkOrder(workOrder)) {
      this.trainingCooldowns.set(workOrder.id, Date.now() + TRAINING_COOLDOWN_MS);
      return;
    }
    this.completedWorkOrderIds.add(workOrder.id);
  }

  setResearchCooldown(workOrderId: string): void {
    this.researchCooldowns.set(workOrderId, Date.now() + RESEARCH_COOLDOWN_MS);
  }

  reset(): void {
    this.researchCooldowns.clear();
    this.trainingCooldowns.clear();
    this.completedWorkOrderIds.clear();
  }
}
