import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { BackpressureService } from '../../work-order/backpressure.service';
import { canLocallyAcceptWorkOrder } from '../../work-order/wo-type-to-cap';
import { getCurrentCapabilities } from '../../../heartbeat/heartbeat';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class AcceptWorkOrderNode {
  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly backpressure: BackpressureService,
  ) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, coordinatorUrl, peerId, walletAddress, capabilities } = state;
    if (!selectedWorkOrder) return { accepted: false };

    // Bug 22 (2026-05-17) — cap-aware local accept gate. The agent state
    // caches `capabilities` from `config.capabilities` at boot and is
    // never refreshed when heartbeat sheds caps under memory pressure
    // (e.g. `diloco_training` stripped because freemem < 6 GB). Without
    // this gate the node POSTs /accept, coord rubber-stamps (stake tier
    // matches), node spins up Qwen2.5-7B and OOMs. We pull the
    // AUTHORITATIVE current snapshot from heartbeat (post-filter,
    // post-hysteresis) — the same set coord knows about.
    const currentCaps = getCurrentCapabilities();
    const gate = canLocallyAcceptWorkOrder(selectedWorkOrder, currentCaps);
    if (!gate.ok) {
      logger.warn(
        `[Accept] Skipping WO ${selectedWorkOrder.id} (${selectedWorkOrder.type ?? '?'}): ${gate.reason}`,
      );
      return { accepted: false };
    }

    // Acquire backpressure slot before accepting
    if (!this.backpressure.acquire(selectedWorkOrder.id)) {
      logger.warn(`[Backpressure] Cannot acquire slot for WO ${selectedWorkOrder.id} — rejecting`);
      return { accepted: false };
    }

    logger.log(' Accepting work order...');
    const accepted = await this.coordinator.acceptWorkOrder(coordinatorUrl, selectedWorkOrder.id, peerId, walletAddress, capabilities);
    if (accepted) {
      logger.log(' Work order accepted');
    } else {
      this.backpressure.release(selectedWorkOrder.id);
      logger.log(' Failed to accept work order (likely race condition)');
    }
    return { accepted };
  }
}
