import { Injectable } from '@nestjs/common';
import { executeTrainingWorkOrder } from '../../work-order-agent';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteTrainingNode {
  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl, peerId, iteration } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing training: ${selectedWorkOrder.title}`);
    try {
      const training = await executeTrainingWorkOrder(
        selectedWorkOrder, coordinatorUrl, peerId, config.capabilities, iteration,
      );
      return { executionResult: { result: training.result, success: training.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` Training execution failed: ${msg}`);
      return { executionResult: { result: `Training failed: ${msg}`, success: false } };
    }
  }
}
