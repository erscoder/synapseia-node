import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteInferenceNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing CPU inference: ${selectedWorkOrder.title}`);
    try {
      const inferenceResult = await this.execution.executeCpuInferenceWorkOrder(
        selectedWorkOrder, config.llmModel, config.llmConfig, coordinatorUrl,
      );
      const result = JSON.stringify({
        ...inferenceResult,
        metricType: 'latency',
        metricValue: inferenceResult.latencyMs,
      });
      return { executionResult: { result, success: true } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` CPU inference failed: ${msg}`);
      return { executionResult: { result: `CPU inference failed: ${msg}`, success: false } };
    }
  }
}
