import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

/**
 * LangGraph node wrapping `executeDockingWorkOrder` for
 * MOLECULAR_DOCKING WOs. Mirrors execute-diloco / execute-inference
 * pattern. QualityGate is shape-agnostic (reads only
 * `executionResult.success`) so docking output flows through without
 * a patch.
 */
@Injectable()
export class ExecuteDockingNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing docking: ${selectedWorkOrder.title}`);
    try {
      const dockingResult = await this.execution.executeDockingWorkOrder(selectedWorkOrder, peerId);
      return { executionResult: { result: dockingResult.result, success: dockingResult.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` Docking execution failed: ${msg}`);
      return { executionResult: { result: `Docking failed: ${msg}`, success: false } };
    }
  }
}
