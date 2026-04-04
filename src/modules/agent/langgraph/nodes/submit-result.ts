import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class SubmitResultNode {
  constructor(private readonly coordinator: WorkOrderCoordinatorHelper) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, executionResult, researchResult, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder || !executionResult) return { submitted: false };

    logger.log(' Reporting result...');
    const completed = await this.coordinator.completeWorkOrder(
      coordinatorUrl, selectedWorkOrder.id, peerId,
      executionResult.result, executionResult.success,
      new Set<string>(),
      () => {},
      () => {},
      (s: string) => BigInt(Math.floor(parseFloat(s) * 1e9)),
    );

    if (completed) {
      logger.log(` Result submitted! Potential reward: ${selectedWorkOrder.rewardAmount} SYN`);
      if (researchResult && selectedWorkOrder.type === 'RESEARCH') {
        await this.coordinator.submitResearchResult(coordinatorUrl, selectedWorkOrder.id, peerId, researchResult);
        logger.log(' Research result submitted to research queue');
      }
    } else {
      logger.log(' Failed to report completion');
    }

    return { submitted: completed };
  }
}
