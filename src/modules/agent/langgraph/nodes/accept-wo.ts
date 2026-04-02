/**
 * Node: acceptWorkOrder
 * Extracts acceptWorkOrder HTTP call from runWorkOrderAgentIteration
 * Pure function: (state) → { accepted: boolean }
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state.js';
import { acceptWorkOrder as acceptWorkOrderApi } from '../../work-order-agent.js';
import logger from '../../../../utils/logger.js';

/**
 * Attempt to accept the selected work order via coordinator API
 * Returns whether acceptance succeeded (may fail due to race condition)
 */
export async function acceptWorkOrderNode(state: AgentState): Promise<Partial<AgentState>> {
  const { selectedWorkOrder, coordinatorUrl, peerId, capabilities } = state;

  if (!selectedWorkOrder) {
    return { accepted: false };
  }

  logger.log(' Accepting work order...');

  const accepted = await acceptWorkOrderApi(
    coordinatorUrl,
    selectedWorkOrder.id,
    peerId,
    capabilities
  );

  if (accepted) {
    logger.log(' Work order accepted');
  } else {
    logger.log(' Failed to accept work order (likely race condition)');
  }

  return { accepted };
}
