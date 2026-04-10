/**
 * SynthesizerNode — third step in the multi-agent research pipeline.
 * Takes researcher + critic outputs and produces the final ResearchResult.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { stripReasoning } from '../../../../shared/sanitize-llm-output';
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

    const research = this.parseResearchResult(researchOutput);

    const prompt = `You are a research synthesizer. Combine a researcher's analysis with peer review critique.

Paper: ${payload.title}

Researcher's analysis:
- Summary: ${research.summary}
- Key Insights: ${research.keyInsights.join('; ')}
- Proposal: ${research.proposal}

Peer review critique:
${criticOutput}

Produce the FINAL refined result that directly addresses the critique's concerns and improves the original analysis.
Output ONLY a JSON object with exactly these fields (no markdown, no extra text):
{"summary":"REAL refined summary here","keyInsights":["REAL refined insight 1","REAL insight 2","REAL insight 3"],"proposal":"REAL concrete next step here"}

Requirements:
- summary: 2-3 sentences that improve on the original, directly addressing the critique. At least 80 characters.
- keyInsights: at least 3 refined findings. Each at least 30 characters.
- proposal: a concrete, actionable next step. At least 100 characters. Must differ from the original proposal if the critique identified weaknesses.`;

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

  private fallbackResult(state: AgentState): Partial<AgentState> {
    const output = state.researcherOutput;
    const parsed = this.parseResearchResult(output || '');
    const researchResult = {
      summary: parsed.summary || 'No summary generated',
      keyInsights: parsed.keyInsights,
      proposal: parsed.proposal || 'No proposal generated',
    };
    return {
      researchResult,
      executionResult: { success: true, result: JSON.stringify(researchResult) },
      qualityScore: 0,
    };
  }

  private parseResearchResult(raw: string): { summary: string; keyInsights: string[]; proposal: string } {
    try {
      const p = JSON.parse(stripReasoning(raw).trim());
      return {
        summary: String(p.summary ?? ''),
        keyInsights: Array.isArray(p.keyInsights) ? p.keyInsights.map(String) : [],
        proposal: String(p.proposal ?? ''),
      };
    } catch {
      return { summary: raw.slice(0, 200), keyInsights: [], proposal: '' };
    }
  }
}
