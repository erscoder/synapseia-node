import { Injectable } from '@nestjs/common';
import { executeDiLoCoWorkOrder } from '../../work-order-agent';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteDilocoNode {
  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing DiLoCo training: ${selectedWorkOrder.title}`);
    try {
      const dilocoResult = await executeDiLoCoWorkOrder(
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
