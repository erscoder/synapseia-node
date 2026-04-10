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

    const completedIds = new Set<string>(state.completedWorkOrderIds ?? []);
    const updatedIds = [...completedIds];

    logger.log(' Reporting result...');
    const completed = await this.coordinator.completeWorkOrder(
      coordinatorUrl, selectedWorkOrder.id, peerId,
      executionResult.result, executionResult.success,
      completedIds,
      (id: string) => updatedIds.push(id),
      () => {},
      (s: string) => BigInt(Math.floor(parseFloat(s) * 1e9)),
    );

    if (completed) {
      logger.log(` Result submitted! Potential reward: ${selectedWorkOrder.rewardAmount} SYN`);
      // Research results are registered in the ResearchRound via completeWorkOrder().
      // The coordinator extracts summary/insights/proposal from the result JSON automatically.
      void researchResult; // kept in state for brain/memory
    } else {
      logger.log(' Failed to report completion');
    }

    return { submitted: completed, completedWorkOrderIds: updatedIds };
  }
}
