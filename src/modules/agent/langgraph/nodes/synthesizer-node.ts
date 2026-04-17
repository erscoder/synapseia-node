/**
 * SynthesizerNode — third step in the multi-agent research pipeline.
 * Takes researcher + critic outputs and produces the final ResearchResult.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { stripReasoning } from '../../../../shared/sanitize-llm-output';
import { buildMedicalSynthesizerPrompt } from '../prompts/medical/medical-synthesizer';
import logger from '../../../../utils/logger';

@Injectable()
export class SynthesizerNode {
  constructor(
    private readonly llmProvider: LlmProviderHelper,
    private readonly coordinator: WorkOrderCoordinatorHelper,
  ) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const researchOutput = state.researcherOutput;
    const criticOutput = state.criticOutput;
    const payload = state.researchPayload;

    if (!researchOutput || !criticOutput || !payload) {
      logger.warn('[SynthesizerNode] Missing inputs — falling back to direct result');
      return this.fallbackResult(state);
    }

    const prompt = buildMedicalSynthesizerPrompt({
      title: payload.title,
      researcherJson: researchOutput,
      criticFeedback: criticOutput,
    });

    try {
      const output = await this.llmProvider.generateLLM(
        state.config?.llmModel ?? { provider: 'ollama', modelId: 'qwen2.5-3b' } as any,
        prompt,
        state.config?.llmConfig,
        { forceJson: true },
      );

      const final = this.parseResearchResult(output);
      logger.log(`[SynthesizerNode] Final result: ${final.summary.slice(0, 80)}...`);

      // Report experiment to coordinator if hyperparams available
      if (state.coordinatorUrl && state.peerId && state.config) {
        const qualityScore = Math.min(10,
          (final.keyInsights.length >= 3 ? 3 : final.keyInsights.length) +
          (final.summary.length > 200 ? 3 : 1) +
          (final.proposal.length > 100 ? 3 : 1),
        );
        try {
          await this.coordinator.reportHyperparamExperiment(
            state.coordinatorUrl,
            state.peerId,
            { id: 'unknown', temperature: 0.7, promptTemplate: 'default', analysisDepth: 'deep' },
            qualityScore,
            0,
          );
        } catch { /* ignore */ }
      }

      const researchResult = {
        summary: final.summary,
        keyInsights: final.keyInsights,
        proposal: final.proposal,
      };
      return {
        researchResult,
        // Required by SubmitResultNode to proceed with submission
        executionResult: { success: true, result: JSON.stringify(researchResult) },
        qualityScore: 0,
      };
    } catch (err) {
      logger.error('[SynthesizerNode] LLM call failed:', (err as Error).message);
      return this.fallbackResult(state);
    }
  }

  /**
   * Fallback when the synthesizer LLM call fails.
   *
   * The researcher emits `{summary, keyInsights, discoveryType, structuredData}`
   * (no proposal — the proposal is built downstream). When the synthesizer
   * fails we still want a submissible result, so we synthesize a proposal
   * locally: plain-English prose + the JSON block from the researcher.
   * The coordinator's extractStructuredPayload regex `/\{[\s\S]*\}/` grabs
   * the JSON block, so the structured discovery is preserved.
   */
  private fallbackResult(state: AgentState): Partial<AgentState> {
    const parsed = this.parseResearchResult(state.researcherOutput || '');
    const summary = parsed.summary || 'No summary generated';
    const proposalFromResearcher =
      parsed.discoveryType && parsed.structuredData
        ? `Proposed discovery: ${parsed.discoveryType}. ${summary} ${JSON.stringify({ discoveryType: parsed.discoveryType, structuredData: parsed.structuredData })}`
        : parsed.proposal || 'No proposal generated';
    const researchResult = {
      summary,
      keyInsights: parsed.keyInsights,
      proposal: proposalFromResearcher,
    };
    return {
      researchResult,
      executionResult: { success: true, result: JSON.stringify(researchResult) },
      qualityScore: 0,
    };
  }

  private parseResearchResult(raw: string): {
    summary: string;
    keyInsights: string[];
    proposal: string;
    discoveryType?: string;
    structuredData?: Record<string, unknown>;
  } {
    try {
      const p = JSON.parse(stripReasoning(raw).trim());
      return {
        summary: String(p.summary ?? ''),
        keyInsights: Array.isArray(p.keyInsights) ? p.keyInsights.map(String) : [],
        proposal: String(p.proposal ?? ''),
        discoveryType: typeof p.discoveryType === 'string' ? p.discoveryType : undefined,
        structuredData:
          p.structuredData && typeof p.structuredData === 'object'
            ? (p.structuredData as Record<string, unknown>)
            : undefined,
      };
    } catch {
      return { summary: raw.slice(0, 200), keyInsights: [], proposal: '' };
    }
  }
}
