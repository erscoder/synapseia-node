/**
 * Node: fetchWorkOrders
 * Extracts the fetch + filter logic from runWorkOrderAgentIteration
 * Sprint A - LangGraph Foundation
 */

import type { AgentState, WorkOrder } from '../state.js';
import { fetchAvailableWorkOrders } from '../../work-order-agent.js';
import { isResearchWorkOrder } from '../../work-order-agent.js';
import logger from '../../../../utils/logger.js';

const RESEARCH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * State variable to track research cooldowns across iterations
 * In the legacy implementation, this was agentState.researchCooldowns
 */
const researchCooldowns = new Map<string, number>();

/**
 * State variable to track completed work order IDs (non-research)
 * In the legacy implementation, this was agentState.completedWorkOrderIds
 */
const completedWorkOrderIds = new Set<string>();

/**
 * Fetch available work orders from the coordinator
 * Filters out:
 * - Research WOs on cooldown (can be re-analyzed after cooldown)
 * - Completed non-research WOs (permanent)
 */
export async function fetchWorkOrders(state: AgentState): Promise<Partial<AgentState>> {
  const { coordinatorUrl, peerId, capabilities } = state;

  logger.log(' Polling for available work orders...');

  // Fetch work orders from coordinator
  const workOrders = await fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);

  if (workOrders.length === 0) {
    logger.log(' No work orders available');
    return { availableWorkOrders: [] };
  }

  logger.log(` Found ${workOrders.length} available work order(s)`);

  // Filter work orders
  const now = Date.now();
  const pendingWorkOrders = workOrders.filter((wo: WorkOrder) => {
    if (isResearchWorkOrder(wo)) {
      // Research: skip only during cooldown period
      const cooldownUntil = researchCooldowns.get(wo.id);
      if (cooldownUntil && now < cooldownUntil) {
        const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
        logger.log(` Research WO "${wo.title}" on cooldown — ${remainingSec}s remaining`);
        return false;
      }
      return true; // Ready to re-analyze with new hyperparams
    }
    // Non-research: skip permanently once completed
    return !completedWorkOrderIds.has(wo.id);
  });

  if (pendingWorkOrders.length < workOrders.length) {
    logger.log(` Skipping ${workOrders.length - pendingWorkOrders.length} WO(s) (completed/cooldown) — ${pendingWorkOrders.length} remaining`);
  }

  if (pendingWorkOrders.length === 0) {
    logger.log(' All work orders completed or on cooldown — waiting');
    return { availableWorkOrders: [] };
  }

  return { availableWorkOrders: pendingWorkOrders };
}

/**
 * Mark a work order as completed (for tracking purposes)
 */
export function markWorkOrderCompleted(workOrder: WorkOrder): void {
  if (!isResearchWorkOrder(workOrder)) {
    completedWorkOrderIds.add(workOrder.id);
  }
}

/**
 * Set research cooldown for a work order
 */
export function setResearchCooldown(workOrderId: string): void {
  researchCooldowns.set(workOrderId, Date.now() + RESEARCH_COOLDOWN_MS);
}

/**
 * Clear all cooldowns and completed work orders
 * Useful for testing
 */
export function resetWorkOrderFilters(): void {
  researchCooldowns.clear();
  completedWorkOrderIds.clear();
}
