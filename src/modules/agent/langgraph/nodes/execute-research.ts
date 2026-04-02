import { Injectable } from '@nestjs/common';
import { executeResearchWorkOrder, scoreResearchResult } from '../../work-order-agent';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteResearchNode {
  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false }, researchResult: null };
    }

    logger.log(` Executing research: ${selectedWorkOrder.title}`);
    try {
      const research = await executeResearchWorkOrder(
        selectedWorkOrder, config.llmModel, config.llmConfig, coordinatorUrl, peerId,
      );
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
      return { executionResult, researchResult: research.result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` Research execution failed: ${msg}`);
      return { executionResult: { result: `Research failed: ${msg}`, success: false }, researchResult: null };
    }
  }
}
