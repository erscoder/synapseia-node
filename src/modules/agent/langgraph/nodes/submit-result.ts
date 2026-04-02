/**
 * Node: submitResult
 * Extracts completeWorkOrder + submitResearchResult logic
 * Returns { submitted }
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state';
import { completeWorkOrder, submitResearchResult } from '../../work-order-agent';
import logger from '../../../../utils/logger';

/**
 * Submit the work order result to the coordinator
 * Handles both standard completion and research result submission
 */
export async function submitResult(state: AgentState): Promise<Partial<AgentState>> {
  const {
    selectedWorkOrder,
    executionResult,
    researchResult,
    coordinatorUrl,
    peerId,
    config,
  } = state;

  if (!selectedWorkOrder || !executionResult) {
    return { submitted: false };
  }

  logger.log(' Reporting result...');

  // Complete the work order
  const completed = await completeWorkOrder(
    coordinatorUrl,
    selectedWorkOrder.id,
    peerId,
    executionResult.result,
    executionResult.success
  );

  if (completed) {
    logger.log(` Result submitted for round evaluation! Potential reward: ${selectedWorkOrder.rewardAmount} SYN`);
    
    // For research work orders: also submit to research queue
    if (researchResult && isResearchWorkOrder(selectedWorkOrder)) {
      await submitResearchResult(
        coordinatorUrl,
        selectedWorkOrder.id,
        peerId,
        researchResult
      );
      logger.log(' Research result submitted to research queue');
    }
  } else {
    logger.log(' Failed to report completion');
  }

  return { submitted: completed };
}

// Helper to check work order type
function isResearchWorkOrder(workOrder: { type?: string }): boolean {
  return workOrder.type === 'RESEARCH';
}
