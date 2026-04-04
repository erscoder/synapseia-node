import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteDilocoNode {
  private readonly execution = new WorkOrderExecutionHelper(
    new WorkOrderCoordinatorHelper(),
    new WorkOrderEvaluationHelper(),
    new LlmProviderHelper(),
  );

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing DiLoCo training: ${selectedWorkOrder.title}`);
    try {
      const dilocoResult = await this.execution.executeDiLoCoWorkOrder(
        selectedWorkOrder, coordinatorUrl, peerId, config.capabilities,
      );
      return { executionResult: { result: dilocoResult.result, success: dilocoResult.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` DiLoCo execution failed: ${msg}`);
      return { executionResult: { result: `DiLoCo failed: ${msg}`, success: false } };
    }
  }
}
