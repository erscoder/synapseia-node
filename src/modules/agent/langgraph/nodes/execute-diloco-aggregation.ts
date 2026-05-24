import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

/**
 * LangGraph node wrapping `executeDilocoAggregationWorkOrder` for
 * DILOCO_AGGREGATION WOs (node-side aggregation re-architecture, Phase 3).
 *
 * DARK until Phase 4: the old coord (flag off) never dispatches this WO,
 * so this node is inert in production until the coord flips
 * `DILOCO_NODE_AGGREGATION_ENABLED=true`. The runner itself fails closed
 * when `AWS_DILOCO_BUCKET` is unset (the node can't reach the shared
 * bucket), so an un-provisioned node simply returns success=false.
 */
@Injectable()
export class ExecuteDilocoAggregationNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing DiLoCo aggregation: ${selectedWorkOrder.title}`);
    try {
      const result = await this.execution.executeDilocoAggregationWorkOrder(
        selectedWorkOrder,
        peerId,
        coordinatorUrl,
      );
      return { executionResult: { result: result.result, success: result.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` DiLoCo aggregation execution failed: ${msg}`);
      return { executionResult: { result: `DiLoCo aggregation failed: ${msg}`, success: false } };
    }
  }
}
