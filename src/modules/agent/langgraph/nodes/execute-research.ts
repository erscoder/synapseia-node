/**
 * Node: executeResearch
 * Wraps executeResearchWorkOrder from legacy implementation
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state';
import { executeResearchWorkOrder } from '../../work-order-agent';
import logger from '../../../../utils/logger';

/**
 * Execute a research work order
 * Fetches KG context, reference corpus, and generates research insights via LLM
 */
export async function executeResearch(state: AgentState): Promise<Partial<AgentState>> {
  const { selectedWorkOrder, config, coordinatorUrl, peerId } = state;

  if (!selectedWorkOrder) {
    return {
      executionResult: { result: 'No work order selected', success: false },
      researchResult: null,
    };
  }

  logger.log(` Executing research: ${selectedWorkOrder.title}`);

  try {
    const research = await executeResearchWorkOrder(
      selectedWorkOrder,
      config.llmModel,
      config.llmConfig,
      coordinatorUrl,
      peerId
    );

    // Format execution result for standard submission
    const executionResult = {
      result: JSON.stringify({
        summary: research.result.summary,
        keyInsights: research.result.keyInsights,
        proposal: research.result.proposal,
        hypothesis: research.result.summary,
        metricType: 'coherence',
        metricValue: research.success ? scoreResearchResult(research.result) : 0.0,
        proof: research.result.proposal,
      }),
      success: research.success,
    };

    return {
      executionResult,
      researchResult: research.result,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(` Research execution failed: ${errorMessage}`);
    
    return {
      executionResult: { result: `Research failed: ${errorMessage}`, success: false },
      researchResult: null,
    };
  }
}

/**
 * Score a research result (placeholder - actual implementation in work-order-agent)
 */
function scoreResearchResult(result: { summary: string; keyInsights: string[]; proposal: string }): number {
  // Simple heuristic scoring
  let score = 0;
  score += result.keyInsights.length >= 3 ? 3 : result.keyInsights.length;
  score += result.summary.length > 200 ? 3 : 1;
  score += result.proposal.length > 100 ? 3 : 1;
  return Math.min(10, Math.max(0, score));
}
