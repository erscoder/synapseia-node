/**
 * SynthesizerNode — third step in the multi-agent research pipeline.
 * Takes researcher + critic outputs and produces the final ResearchResult.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
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

Produce the FINAL ResearchResult, incorporating the critique:

\`\`\`json
{
  "summary": "Refined 2-3 sentence summary, addressing critique",
  "keyInsights": [
    "Refined insight 1 (addresses critique)",
    "Refined insight 2",
    "Refined insight 3"
  ],
  "proposal": "Next step refined in light of the critique"
}
\`\`\`
Respond only with valid JSON.`;

    try {
      const output = await this.llmProvider.generateLLM(
        state.config?.llmModel ?? { provider: 'ollama', modelId: 'qwen2.5-3b' } as any,
        prompt,
        undefined,
        undefined,
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

      return {
        researchResult: {
          summary: final.summary,
          keyInsights: final.keyInsights,
          proposal: final.proposal,
        },
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
    return {
      researchResult: {
        summary: parsed.summary || 'No summary generated',
        keyInsights: parsed.keyInsights,
        proposal: parsed.proposal || 'No proposal generated',
      },
      qualityScore: 0,
    };
  }

  private parseResearchResult(raw: string): { summary: string; keyInsights: string[]; proposal: string } {
    let jsonStr = String(raw)
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```json\s*|```\s*/g, '')
      .trim();
    jsonStr = jsonStr.replace(/^\\n+/, '');
    // eslint-disable-next-line no-control-regex
    jsonStr = jsonStr.replace(/[\x00-\x1f\x7f]/g, (ch) => {
      if (ch === '\n') return '\\n';
      if (ch === '\t') return '\\t';
      return '';
    });
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    try {
      const p = JSON.parse(jsonStr);
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
