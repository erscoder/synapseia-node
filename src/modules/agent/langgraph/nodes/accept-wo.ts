import { Injectable } from '@nestjs/common';
import { acceptWorkOrder } from '../../work-order-agent';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class AcceptWorkOrderNode {
  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, coordinatorUrl, peerId, capabilities } = state;
    if (!selectedWorkOrder) return { accepted: false };

    logger.log(' Accepting work order...');
    const accepted = await acceptWorkOrder(coordinatorUrl, selectedWorkOrder.id, peerId, capabilities);
    if (accepted) {
      logger.log(' Work order accepted');
    } else {
      logger.log(' Failed to accept work order (likely race condition)');
    }
    return { accepted };
  }
}
