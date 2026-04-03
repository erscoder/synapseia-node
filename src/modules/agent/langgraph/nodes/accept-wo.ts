import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class AcceptWorkOrderNode {
  private readonly coordinator = new WorkOrderCoordinatorHelper();

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, coordinatorUrl, peerId, capabilities } = state;
    if (!selectedWorkOrder) return { accepted: false };

    logger.log(' Accepting work order...');
    const accepted = await this.coordinator.acceptWorkOrder(coordinatorUrl, selectedWorkOrder.id, peerId, capabilities);
    if (accepted) {
      logger.log(' Work order accepted');
    } else {
      logger.log(' Failed to accept work order (likely race condition)');
    }
    return { accepted };
  }
}
