import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteTrainingNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl, peerId, iteration } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing training: ${selectedWorkOrder.title}`);
    try {
      const training = await this.execution.executeTrainingWorkOrder(
        selectedWorkOrder, coordinatorUrl, peerId, config.capabilities, iteration,
        config.llmModel, config.llmConfig, [],
      );
      return { executionResult: { result: training.result, success: training.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` Training execution failed: ${msg}`);
      return { executionResult: { result: `Training failed: ${msg}`, success: false } };
    }
  }
}
