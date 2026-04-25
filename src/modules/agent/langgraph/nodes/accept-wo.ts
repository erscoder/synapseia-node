import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { BackpressureService } from '../../work-order/backpressure.service';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class AcceptWorkOrderNode {
  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly backpressure: BackpressureService,
  ) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, coordinatorUrl, peerId, capabilities } = state;
    if (!selectedWorkOrder) return { accepted: false };

    // Acquire backpressure slot before accepting
    if (!this.backpressure.acquire(selectedWorkOrder.id)) {
      logger.warn(`[Backpressure] Cannot acquire slot for WO ${selectedWorkOrder.id} — rejecting`);
      return { accepted: false };
    }

    logger.log(' Accepting work order...');
    const accepted = await this.coordinator.acceptWorkOrder(coordinatorUrl, selectedWorkOrder.id, peerId, capabilities);
    if (accepted) {
      logger.log(' Work order accepted');
    } else {
      this.backpressure.release(selectedWorkOrder.id);
      logger.log(' Failed to accept work order (likely race condition)');
    }
    return { accepted };
  }
}
