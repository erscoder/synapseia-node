import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { BackpressureService } from '../../work-order/backpressure.service';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import type { AgentState, WorkOrder } from '../state';
import logger from '../../../../utils/logger';
import { isChatInferenceActive } from '../../../inference/chat-inference-state';

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

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    // Backpressure: if at capacity, skip polling entirely
    if (!this.backpressure.canAccept()) {
      logger.warn(
        `[Backpressure] At capacity (${this.backpressure.getInFlight()}/${this.backpressure.getMaxConcurrent()}) — skipping poll`,
      );
      return { availableWorkOrders: [] };
    }

    const { coordinatorUrl, peerId, capabilities, rejectedWorkOrderIds = [] } = state;
    logger.log(' Polling for available work orders...');

    const workOrders = await this.coordinator.fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
    if (workOrders.length === 0) {
      logger.log(' No work orders available');
      return { availableWorkOrders: [] };
    }

    logger.log(` Found ${workOrders.length} available work order(s)`);
    const now = Date.now();

    const ownCaps = new Set(capabilities ?? []);
    const pending = workOrders.filter((wo: WorkOrder) => {
      // Capability guard: the coordinator should already filter by registered
      // capabilities, but defend against mismatches (e.g. a coordinator that
      // trusts self-reported caps, or a WO whose requirements were tightened
      // after the node's heartbeat). Without this guard the node wastes an
      // HTTP round-trip and logs "likely race condition" on the inevitable
      // 400 from /accept.
      const required = wo.requiredCapabilities ?? [];
      const missing = required.filter(c => !ownCaps.has(c));
      if (missing.length > 0) {
        logger.log(` WO "${wo.title}" requires [${required.join(',')}] — missing [${missing.join(',')}], skipping`);
        return false;
      }
      // Skip work orders already rejected by economic evaluation
      if (rejectedWorkOrderIds.includes(wo.id)) {
        logger.log(` WO "${wo.title}" rejected by economics — skipping`);
        return false;
      }
      if (this.execution.isResearchWorkOrder(wo)) {
        const cooldownUntil = this.researchCooldowns.get(wo.id);
        if (cooldownUntil && now < cooldownUntil) {
          const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
          logger.log(` Research WO "${wo.title}" on cooldown — ${remainingSec}s remaining`);
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
          return false;
        }
        // Training WOs are retry-friendly: ranking uses best score per peer,
        // so a second attempt with a new mutation can promote the node. Apply
        // a cooldown instead of permanent exclusion.
        const cooldownUntil = this.trainingCooldowns.get(wo.id);
        if (cooldownUntil && now < cooldownUntil) {
          const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
          logger.log(` Training WO "${wo.title}" on cooldown — ${remainingSec}s remaining`);
          return false;
        }
        return true;
      }
      return !this.completedWorkOrderIds.has(wo.id);
    });

    if (pending.length < workOrders.length) {
      logger.log(` Skipping ${workOrders.length - pending.length} WO(s) — ${pending.length} remaining`);
    }
    if (pending.length === 0) {
      logger.log(' All work orders skipped (completed / cooldown / rejected by economics) — waiting');
      return { availableWorkOrders: [] };
    }

    return { availableWorkOrders: pending };
  }

  markCompleted(workOrder: WorkOrder): void {
    // Re-entry policy by WO type:
    //  - RESEARCH: long cooldown (5 min default) — nodes re-analyse with new
    //    hyperparams, but not back-to-back on the same paper.
    //  - TRAINING / DILOCO_TRAINING: short cooldown (60s default) — nodes
    //    retry with fresh mutations; ranker takes MAX score per peer.
    //  - everything else (inference, etc.): permanent exclusion.
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
