/**
 * Self-Critique Node
 * Sprint B - LLM reviews its own research output
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import type { LangGraphLlmService } from '../llm.service';
import { 
  buildSelfCritiquePrompt, 
  parseSelfCritiqueResponse, 
  calculateAverageScore 
} from '../prompts/self-critique';
import logger from '../../../../utils/logger';

const MAX_RETRIES = 2;
const PASSING_THRESHOLD = 7.0;

@Injectable()
export class SelfCritiqueNode {
  constructor(private readonly llmService: LangGraphLlmService) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, researchResult, retryCount, config } = state;

    // Only critique research work orders - fast path for others
    if (!selectedWorkOrder || selectedWorkOrder.type !== 'RESEARCH') {
      logger.log('[SelfCritiqueNode] Skipping critique for non-research WO');
      return {
        selfCritiqueScore: 0,
        selfCritiquePassed: true,
        selfCritiqueFeedback: '',
      };
    }

    // Need research result to critique
    if (!researchResult) {
      logger.warn('[SelfCritiqueNode] No research result to critique');
      return {
        selfCritiqueScore: 0,
        selfCritiquePassed: false,
        selfCritiqueFeedback: 'No research result available for critique',
        retryCount: Math.min((retryCount || 0) + 1, MAX_RETRIES),
      };
    }

    try {
      // Build the critique prompt
      const prompt = buildSelfCritiquePrompt({
        title: selectedWorkOrder.title,
        summary: researchResult.summary || '',
        keyInsights: Array.isArray(researchResult.keyInsights) 
          ? researchResult.keyInsights.join(', ') 
          : String(researchResult.keyInsights || ''),
        proposal: researchResult.proposal || '',
      });

      // Call LLM for critique
      const llmResponse = await this.llmService.generate(
        config.llmModel,
        prompt,
        config.llmConfig
      );

      // Parse the critique response
      const critique = parseSelfCritiqueResponse(llmResponse);
      const averageScore = calculateAverageScore(critique);
      const passed = averageScore >= PASSING_THRESHOLD;

      // Increment retry count if failed
      const newRetryCount = passed 
        ? (retryCount || 0) 
        : Math.min((retryCount || 0) + 1, MAX_RETRIES);

      logger.log(
        `[SelfCritiqueNode] Score: ${averageScore.toFixed(1)}/10, Passed: ${passed}, ` +
        `Retries: ${newRetryCount}/${MAX_RETRIES}`
      );

      return {
        selfCritiqueScore: averageScore,
        selfCritiquePassed: passed,
        selfCritiqueFeedback: critique.feedback,
        retryCount: newRetryCount,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[SelfCritiqueNode] Critique failed: ${msg}`);

      // Graceful degradation - mark as failed but don't crash
      const newRetryCount = Math.min((retryCount || 0) + 1, MAX_RETRIES);
      return {
        selfCritiqueScore: 0,
        selfCritiquePassed: false,
        selfCritiqueFeedback: `Critique error: ${msg}`,
        retryCount: newRetryCount,
      };
    }
  }
}
