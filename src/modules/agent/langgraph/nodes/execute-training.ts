import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { LlmProviderHelper, type LLMModel } from '../../../llm/llm-provider';
import { resolveTrainingChain } from '../../../llm/training-llm';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteTrainingNode {
  constructor(private readonly execution: WorkOrderExecutionHelper) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl, peerId, iteration } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.log(` Executing training: ${selectedWorkOrder.title}`);

    // Resolve primary + full fallback chain. The CLI --model flag is typically
    // an inference-sized model; we use the best training-capable LLM and keep
    // every other available model as a fallback so a single model's JSON
    // glitch (e.g. minimax appending stray tokens) doesn't kill the WO.
    const chain = await resolveTrainingChain();
    if (!chain) {
      logger.warn(' No capable training LLM — aborting training WO');
      return {
        executionResult: {
          result: 'No training LLM available (no Ollama models and no LLM_CLOUD_MODEL)',
          success: false,
        },
      };
    }

    try {
      const training = await this.execution.executeTrainingWorkOrder(
        selectedWorkOrder, coordinatorUrl, peerId, config.capabilities, iteration,
        chain.primary, config.llmConfig, chain.fallbacks,
      );
      return { executionResult: { result: training.result, success: training.success } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Recoverable: the surrounding agent loop returns success:false and the
      // coordinator reassigns. The error path here is mostly defensive (the
      // executor itself catches its own failures); when it does fire it's
      // typically a programming guard (e.g. invalid input shape) rather than
      // an outage, so warn is the right signal level.
      logger.warn(` Training execution failed: ${msg}`);
      return { executionResult: { result: `Training failed: ${msg}`, success: false } };
    }
  }
}
