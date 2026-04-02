/**
 * Node: executeTraining
 * Wraps executeTrainingWorkOrder from legacy implementation
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state';
import { executeTrainingWorkOrder } from '../../work-order-agent';
import logger from '../../../../utils/logger';

/**
 * Execute a training work order
 * Downloads dataset and runs train_micro.py
 */
export async function executeTraining(state: AgentState): Promise<Partial<AgentState>> {
  const { selectedWorkOrder, config, coordinatorUrl, peerId, iteration } = state;

  if (!selectedWorkOrder) {
    return {
      executionResult: { result: 'No work order selected', success: false },
    };
  }

  logger.log(` Executing training: ${selectedWorkOrder.title}`);

  try {
    const training = await executeTrainingWorkOrder(
      selectedWorkOrder,
      coordinatorUrl,
      peerId,
      config.capabilities,
      iteration
    );

    return {
      executionResult: {
        result: training.result,
        success: training.success,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(` Training execution failed: ${errorMessage}`);
    
    return {
      executionResult: { result: `Training failed: ${errorMessage}`, success: false },
    };
  }
}
