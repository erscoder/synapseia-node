import { Injectable } from '@nestjs/common';
import { evaluateWorkOrder, loadEconomicConfig } from '../../work-order-agent';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class EvaluateEconomicsNode {
  execute(state: AgentState): Partial<AgentState> {
    const { selectedWorkOrder, config } = state;
    if (!selectedWorkOrder) return { economicEvaluation: null };

    const fullModelId = this.buildFullModelId(config);
    const economicConfig = loadEconomicConfig(fullModelId);
    const evaluation = evaluateWorkOrder(selectedWorkOrder, economicConfig);

    logger.log(` Economic evaluation: Bounty=${evaluation.bountyUsd.toFixed(4)} USD, Cost=${evaluation.estimatedCostUsd.toFixed(4)} USD → ${evaluation.shouldAccept ? 'ACCEPT' : 'SKIP'}`);
    return { economicEvaluation: evaluation };
  }

  private buildFullModelId(config: AgentState['config']): string | undefined {
    const { llmModel } = config;
    if (!llmModel) return undefined;
    if (llmModel.provider === 'ollama') return `ollama/${llmModel.modelId}`;
    if (llmModel.providerId) return `${llmModel.providerId}/${llmModel.modelId}`;
    return llmModel.modelId;
  }
}
