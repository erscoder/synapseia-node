/**
 * Node: executeInference
 * Wraps executeCpuInferenceWorkOrder from legacy implementation
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state';
import { executeCpuInferenceWorkOrder } from '../../work-order-agent';
import logger from '../../../../utils/logger';

/**
 * Execute a CPU inference work order
 * Runs embedding, tokenization, or classification tasks
 */
export async function executeInference(state: AgentState): Promise<Partial<AgentState>> {
  const { selectedWorkOrder, config, coordinatorUrl } = state;

  if (!selectedWorkOrder) {
    return {
      executionResult: { result: 'No work order selected', success: false },
    };
  }

  logger.log(` Executing CPU inference: ${selectedWorkOrder.title}`);

  try {
    const inferenceResult = await executeCpuInferenceWorkOrder(
      selectedWorkOrder,
      config.llmModel,
      config.llmConfig,
      coordinatorUrl
    );

    return {
      executionResult: {
        result: JSON.stringify({
          ...inferenceResult,
          metricType: 'latency',
          metricValue: inferenceResult.latencyMs,
        }),
        success: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(` CPU inference execution failed: ${errorMessage}`);
    
    return {
      executionResult: { result: `CPU inference failed: ${errorMessage}`, success: false },
    };
  }
}
