import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import type { AgentState, WorkOrder } from '../state';
import logger from '../../../../utils/logger';

const RESEARCH_COOLDOWN_MS = parseInt(process.env.RESEARCH_COOLDOWN_MS ?? String(5 * 60 * 1000), 10);

@Injectable()
export class FetchWorkOrdersNode {
  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly execution: WorkOrderExecutionHelper,
  ) {}


  private readonly researchCooldowns = new Map<string, number>();
  private readonly completedWorkOrderIds = new Set<string>();

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { coordinatorUrl, peerId, capabilities } = state;
    logger.log(' Polling for available work orders...');

    const workOrders = await this.coordinator.fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
    if (workOrders.length === 0) {
      logger.log(' No work orders available');
      return { availableWorkOrders: [] };
    }

    logger.log(` Found ${workOrders.length} available work order(s)`);
    const now = Date.now();

    const pending = workOrders.filter((wo: WorkOrder) => {
      if (this.execution.isResearchWorkOrder(wo)) {
        const cooldownUntil = this.researchCooldowns.get(wo.id);
        if (cooldownUntil && now < cooldownUntil) {
          const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
          logger.log(` Research WO "${wo.title}" on cooldown — ${remainingSec}s remaining`);
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
      logger.log(' All work orders completed or on cooldown — waiting');
      return { availableWorkOrders: [] };
    }

    return { availableWorkOrders: pending };
  }

  markCompleted(workOrder: WorkOrder): void {
    if (!this.execution.isResearchWorkOrder(workOrder)) {
      this.completedWorkOrderIds.add(workOrder.id);
    }
  }

  setResearchCooldown(workOrderId: string): void {
    this.researchCooldowns.set(workOrderId, Date.now() + RESEARCH_COOLDOWN_MS);
  }

  reset(): void {
    this.researchCooldowns.clear();
    this.completedWorkOrderIds.clear();
  }
}
