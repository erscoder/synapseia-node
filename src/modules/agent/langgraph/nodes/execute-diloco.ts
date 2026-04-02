/**
 * Node: executeDiloco
 * Wraps executeDiLoCoWorkOrder from legacy implementation
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state';
import { executeDiLoCoWorkOrder } from '../../work-order-agent';
import logger from '../../../../utils/logger';

/**
 * Execute a DiLoCo training work order
 * Runs distributed local cooperative training
 */
export async function executeDiloco(state: AgentState): Promise<Partial<AgentState>> {
  const { selectedWorkOrder, config, coordinatorUrl, peerId } = state;

  if (!selectedWorkOrder) {
    return {
      executionResult: { result: 'No work order selected', success: false },
    };
  }

  logger.log(` Executing DiLoCo training: ${selectedWorkOrder.title}`);

  try {
    const dilocoResult = await executeDiLoCoWorkOrder(
      selectedWorkOrder,
      coordinatorUrl,
      peerId,
      config.capabilities
    );

    return {
      executionResult: {
        result: dilocoResult.result,
        success: dilocoResult.success,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(` DiLoCo execution failed: ${errorMessage}`);
    
    return {
      executionResult: { result: `DiLoCo failed: ${errorMessage}`, success: false },
    };
  }
}
