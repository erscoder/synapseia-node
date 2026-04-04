/**
 * CriticNode — second step in the multi-agent research pipeline.
 * Takes the researcher's output from state and produces a critical review.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import logger from '../../../../utils/logger';

@Injectable()
export class CriticNode {
  constructor(
    private readonly llmProvider: LlmProviderHelper,
    private readonly coordinator: WorkOrderCoordinatorHelper,
  ) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const researchOutput = state.researcherOutput;
    if (!researchOutput) {
      logger.warn('[CriticNode] No researcher output in state');
      return { criticOutput: '' };
    }

    const payload = state.researchPayload;
    if (!payload) {
      logger.warn('[CriticNode] No research payload in state');
      return { criticOutput: '' };
    }

    const research = this.parseResearchResult(researchOutput);
    const prompt = `You are a rigorous peer reviewer. A researcher has analyzed this paper:

Paper: ${payload.title}

Researcher's analysis:
- Summary: ${research.summary}
- Key Insights: ${research.keyInsights.map((i, n) => `${n + 1}. ${i}`).join('\n')}
- Proposal: ${research.proposal}

Critically evaluate this analysis. Identify weaknesses, overstatements, missing context, or gaps.

Respond with JSON:
\`\`\`json
{
  "assessment": "Your quality score (1-10) and brief rationale",
  "concerns": ["concern 1", "concern 2"],
  "suggestions": ["improvement 1", "improvement 2"]
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
      logger.log(`[CriticNode] Generated critique (${output.length} chars)`);
      return { criticOutput: output };
    } catch (err) {
      logger.error('[CriticNode] LLM call failed:', (err as Error).message);
      return { criticOutput: '' };
    }
  }

  private parseResearchResult(raw: string): { summary: string; keyInsights: string[]; proposal: string } {
    let jsonStr = String(raw)
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```json\s*|```\s*/g, '')
      .trim();
    // Strip leading literal \n
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
