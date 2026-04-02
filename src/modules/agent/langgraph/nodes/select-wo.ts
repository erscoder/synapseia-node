/**
 * Node: selectBestWorkOrder
 * Extracts WO selection logic from runWorkOrderAgentIteration
 * Currently takes the first available (same as legacy)
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state.js';
import logger from '../../../../utils/logger.js';

/**
 * Select the best work order from available work orders
 * Currently: first available (same as legacy implementation)
 * 
 * TODO (Sprint B): Add LLM-based selection considering:
 * - Work order domain matching node capabilities
 * - Reward optimization
 * - Historical success rate
 */
export function selectBestWorkOrder(state: AgentState): Partial<AgentState> {
  const { availableWorkOrders } = state;

  if (availableWorkOrders.length === 0) {
    return { selectedWorkOrder: null };
  }

  // Currently: take the first available work order
  // This maintains backward compatibility with legacy behavior
  const selected = availableWorkOrders[0];

  logger.log(` Selected: "${selected.title}" (reward: ${selected.rewardAmount} SYN)`);

  return { selectedWorkOrder: selected };
}
