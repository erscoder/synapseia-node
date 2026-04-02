import { Injectable } from '@nestjs/common';
import { completeWorkOrder, submitResearchResult } from '../../work-order-agent';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class SubmitResultNode {
  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, executionResult, researchResult, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder || !executionResult) return { submitted: false };

    logger.log(' Reporting result...');
    const completed = await completeWorkOrder(
      coordinatorUrl, selectedWorkOrder.id, peerId,
      executionResult.result, executionResult.success,
    );

    if (completed) {
      logger.log(` Result submitted! Potential reward: ${selectedWorkOrder.rewardAmount} SYN`);
      if (researchResult && selectedWorkOrder.type === 'RESEARCH') {
        await submitResearchResult(coordinatorUrl, selectedWorkOrder.id, peerId, researchResult);
        logger.log(' Research result submitted to research queue');
      }
    } else {
      logger.log(' Failed to report completion');
    }

    return { submitted: completed };
  }
}
