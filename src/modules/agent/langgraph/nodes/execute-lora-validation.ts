import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

/**
 * LangGraph node wrapping `executeLoraValidationWorkOrder` for
 * LORA_VALIDATION WOs. OPT-IN: gated on `LORA_VALIDATOR_ENABLED=true`
 * (CLI flag `--lora-validator`). When disabled the helper itself
 * returns `{ result: 'validator-disabled', success: false }` so the
 * gate is enforced once in the helper. We also short-circuit here to
 * keep the symmetry obvious for reviewers and to log a clear node-
 * level message.
 */
@Injectable()
export class ExecuteLoraValidationNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    if (process.env.LORA_VALIDATOR_ENABLED !== 'true') {
      logger.warn(
        ` LORA_VALIDATION WO ${selectedWorkOrder.id} skipped: lora validator disabled ` +
        `(pass --lora-validator to opt in).`,
      );
      return { executionResult: { result: 'lora validator disabled', success: false } };
    }

    logger.log(` Executing LoRA validation: ${selectedWorkOrder.title}`);
    try {
      const result = await this.execution.executeLoraValidationWorkOrder(selectedWorkOrder, peerId);
      return { executionResult: { result: result.result, success: result.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` LoRA validation execution failed: ${msg}`);
      return { executionResult: { result: `LoRA validation failed: ${msg}`, success: false } };
    }
  }
}
