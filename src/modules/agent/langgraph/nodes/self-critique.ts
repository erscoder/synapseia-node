/**
 * Self-Critique Node
 * Sprint B - LLM reviews its own research output
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LangGraphLlmService } from '../llm.service';
import {
  buildMedicalSelfCritiquePrompt,
  parseMedicalSelfCritiqueResponse,
  calculateMedicalAverageScore,
} from '../prompts/medical/medical-self-critique';
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
      // Build the medical critique prompt (5 dims: accuracy, completeness,
      // novelty, actionability, ontologyGrounding). Pass the abstract +
      // related DOIs as grounding sources so the critic can verify the
      // supporting_dois weren't invented.
      const meta = (selectedWorkOrder.metadata ?? {}) as Record<string, unknown>;
      const abstract = typeof meta['paperAbstract'] === 'string' ? meta['paperAbstract'] : '';
      const paperDoi = typeof meta['paperDoi'] === 'string' ? meta['paperDoi'] : '';
      const relatedDois = Array.isArray(meta['relatedDois'])
        ? (meta['relatedDois'] as unknown[]).filter((d): d is string => typeof d === 'string')
        : [];
      const groundingSources = [
        abstract ? `Abstract:\n${abstract}` : '',
        paperDoi ? `Paper DOI: ${paperDoi}` : '',
        relatedDois.length ? `Related DOIs:\n${relatedDois.map((d) => `  - ${d}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');

      const prompt = buildMedicalSelfCritiquePrompt({
        title: selectedWorkOrder.title,
        summary: researchResult.summary || '',
        keyInsights: Array.isArray(researchResult.keyInsights)
          ? researchResult.keyInsights.join(', ')
          : String(researchResult.keyInsights || ''),
        proposal: researchResult.proposal || '',
        groundingSources: groundingSources || undefined,
      });

      const llmResponse = await this.llmService.generateJSON(
        config.llmModel,
        prompt,
        config.llmConfig,
      );

      const critique = parseMedicalSelfCritiqueResponse(llmResponse);
      const averageScore = calculateMedicalAverageScore(critique);
      // Pass requires 5-dim avg ≥ 7.0 AND ontologyGrounding ≥ 6 (enforced in the parser).
      const passed = critique.passed && averageScore >= PASSING_THRESHOLD;

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
