import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

/**
 * LangGraph node wrapping `executeDilocoValidationWorkOrder` for
 * DILOCO_VALIDATION WOs (DiLoCo B-validator, Phase 4B).
 *
 * The `diloco_validation` capability is advertised by heartbeat ONLY when the
 * torch + transformers + peft stack AND the pre-downloaded foundation model
 * are present (gated identically to `diloco_training`), so an old / CPU-only
 * node never receives this WO. The runner itself fails closed (sha256
 * mismatch, missing presigned URL, identity mismatch) and returns
 * success=false on any failure.
 */
@Injectable()
export class ExecuteDilocoValidationNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing DiLoCo validation: ${selectedWorkOrder.title}`);
    try {
      const result = await this.execution.executeDilocoValidationWorkOrder(
        selectedWorkOrder,
        peerId,
        coordinatorUrl,
      );
      return { executionResult: { result: result.result, success: result.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` DiLoCo validation execution failed: ${msg}`);
      return { executionResult: { result: `DiLoCo validation failed: ${msg}`, success: false } };
    }
  }
}
