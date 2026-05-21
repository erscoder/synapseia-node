/**
 * CriticNode — second step in the multi-agent research pipeline.
 * Takes the researcher's output from state and produces a critical review.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { parseLlmJson } from '../../../../shared/parse-llm-json';
import { sanitizeForPrompt, PromptSafetyError } from '../../../../shared/prompt-safety';
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

    // P26 prompt-safety gate (F-node-004). `payload.title` is peer-controlled
    // (the WO author is untrusted). summary/keyInsights/proposal are our own
    // researcher LLM's output, but the researcher prompt interpolates the
    // peer-controlled abstract, so that output can echo a crafted directive
    // back here — gate them all, mirroring the sibling SynthesizerNode path.
    // Jailbreak markers HARD-reject (throws); length truncates in place. On a
    // jailbreak throw we emit telemetry and return empty criticOutput so the
    // pipeline degrades gracefully (synthesizer falls back) — fail-closed.
    let prompt: string;
    try {
      const safeTitle = sanitizeForPrompt(payload.title, 'title');
      const safeSummary = sanitizeForPrompt(research.summary, 'summary');
      const safeKeyInsights = research.keyInsights.map((i, n) =>
        sanitizeForPrompt(i, `keyInsight[${n}]`),
      );
      const safeProposal = sanitizeForPrompt(research.proposal, 'proposal');
      prompt = `You are a rigorous peer reviewer. A researcher has analyzed this paper:

Paper: ${safeTitle}

Researcher's analysis:
- Summary: ${safeSummary}
- Key Insights: ${safeKeyInsights.map((i, n) => `${n + 1}. ${i}`).join('\n')}
- Proposal: ${safeProposal}

Critically evaluate this analysis. Identify weaknesses, overstatements, missing context, or gaps.

Output ONLY a JSON object with exactly these fields (no markdown, no extra text):
{"assessment":"REAL score 1-10 and one-sentence rationale here","concerns":["REAL weakness or gap 1","REAL weakness or gap 2"],"suggestions":["REAL specific improvement 1","REAL specific improvement 2"]}

Requirements:
- assessment: a number from 1 to 10 followed by a one-sentence rationale. Be honest and specific.
- concerns: at least 2 real weaknesses, overstatements, or missing context — not generic complaints.
- suggestions: at least 2 concrete, actionable improvements the researcher could make.`;
    } catch (err) {
      if (err instanceof PromptSafetyError) {
        logger.warn(
          `[CriticNode] event=prompt_safety_violation source=critic ` +
          `field=${err.fieldName} reason=${err.reason} ` +
          `marker=${JSON.stringify(err.markerPreview ?? '')}`,
        );
        return { criticOutput: '' };
      }
      throw err;
    }

    try {
      const output = await this.llmProvider.generateLLM(
        state.config?.llmModel ?? { provider: 'ollama', modelId: 'qwen2.5-3b' } as any,
        prompt,
        state.config?.llmConfig,
        { forceJson: true },
      );
      logger.log(`[CriticNode] Generated critique (${output.length} chars)`);
      return { criticOutput: output };
    } catch (err) {
      logger.error('[CriticNode] LLM call failed:', (err as Error).message);
      return { criticOutput: '' };
    }
  }

  private parseResearchResult(raw: string): { summary: string; keyInsights: string[]; proposal: string } {
    const result = parseLlmJson<{ summary?: unknown; keyInsights?: unknown; proposal?: unknown }>(raw);
    if (!result.ok || !result.value) {
      return { summary: raw.slice(0, 200), keyInsights: [], proposal: '' };
    }
    const p = result.value;
    return {
      summary: String(p.summary ?? ''),
      keyInsights: Array.isArray(p.keyInsights) ? p.keyInsights.map(String) : [],
      proposal: String(p.proposal ?? ''),
    };
  }
}
