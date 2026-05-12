import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

/**
 * LangGraph node wrapping `executeLoraWorkOrder` for LORA_TRAINING
 * WOs. Mirrors execute-diloco pattern. QualityGate is shape-agnostic
 * (reads only `executionResult.success`) so LoRA submission JSON
 * flows through unchanged.
 */
@Injectable()
export class ExecuteLoraNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing LoRA training: ${selectedWorkOrder.title}`);
    try {
      const loraResult = await this.execution.executeLoraWorkOrder(selectedWorkOrder, peerId);
      return { executionResult: { result: loraResult.result, success: loraResult.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` LoRA training execution failed: ${msg}`);
      return { executionResult: { result: `LoRA training failed: ${msg}`, success: false } };
    }
  }
}
