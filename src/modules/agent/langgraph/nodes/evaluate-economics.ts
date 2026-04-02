/**
 * Node: evaluateEconomics
 * Extracts evaluateWorkOrder + loadEconomicConfig call
 * Pure function: (state) → { economicEvaluation }
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state.js';
import { evaluateWorkOrder, loadEconomicConfig } from '../../work-order-agent.js';
import logger from '../../../../utils/logger.js';

/**
 * Evaluate the economic viability of the selected work order
 * Calculates bounty in USD, estimates LLM cost, and determines profitability
 */
export function evaluateEconomics(state: AgentState): Partial<AgentState> {
  const { selectedWorkOrder, config } = state;

  if (!selectedWorkOrder) {
    return { economicEvaluation: null };
  }

  // Build full model identifier for correct local vs cloud detection
  const fullModelId = buildFullModelId(config);

  // Load economic configuration
  const economicConfig = loadEconomicConfig(fullModelId);

  // Evaluate work order economics
  const evaluation = evaluateWorkOrder(selectedWorkOrder, economicConfig);

  logger.log(` Economic evaluation:`);
  logger.log(`  - Bounty: ${evaluation.bountyUsd.toFixed(4)} USD (${selectedWorkOrder.rewardAmount} SYN)`);
  logger.log(`  - Est. cost: ${evaluation.estimatedCostUsd.toFixed(4)} USD`);
  logger.log(`  - Profit ratio: ${evaluation.profitRatio === Infinity ? '∞' : evaluation.profitRatio.toFixed(2) + 'x'}`);
  logger.log(`  - Decision: ${evaluation.shouldAccept ? 'ACCEPT' : 'SKIP'} (${evaluation.reason})`);

  return { economicEvaluation: evaluation };
}

/**
 * Build full model identifier from config
 * e.g. "ollama/qwen2.5:0.5b" so loadEconomicConfig can detect local vs cloud
 */
function buildFullModelId(config: AgentState['config']): string | undefined {
  const { llmModel } = config;
  if (!llmModel) return undefined;

  if (llmModel.provider === 'ollama') {
    return `ollama/${llmModel.modelId}`;
  }

  if (llmModel.providerId) {
    return `${llmModel.providerId}/${llmModel.modelId}`;
  }

  return llmModel.modelId;
}
