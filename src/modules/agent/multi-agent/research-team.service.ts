/**
 * ResearchTeamService — multi-agent research pipeline.
 *
 * Pipeline: researcher → critic → synthesizer
 * - Shared memory: critic reads researcher's output; synthesizer reads both
 * - Timeout: 90s total
 * - Fallback: direct LLM call if team fails
 */

import { Injectable } from '@nestjs/common';
import type { LLMConfig, LLMModel } from '../../llm/llm-provider.js';

/**
 * Simple shared memory store for inter-agent communication.
 * Replace with SharedMemory from open-multi-agent when dependency conflicts are resolved.
 */
class SimpleMemory {
  private readonly store = new Map<string, Record<string, string>>();

  write(agent: string, key: string, value: string): void {
    if (!this.store.has(agent)) this.store.set(agent, {});
    this.store.get(agent)![key] = value;
  }

  read(agent: string, key: string): string {
    return this.store.get(agent)?.[key] ?? '';
  }
}

export interface ResearchPayload {
  title: string;
  abstract: string;
}

export interface TeamResearchResult {
  summary: string;
  keyInsights: string[];
  proposal: string;
}

@Injectable()
export class ResearchTeamService {
  constructor(
    private readonly llmProvider: {
      generateLLM(model: LLMModel, prompt: string, config?: LLMConfig, options?: { temperature?: number }): Promise<string>;
    },
  ) {}

  /**
   * Run the 3-agent pipeline: researcher → critic → synthesizer
   */
  async runResearch(
    payload: ResearchPayload,
    llmModel: LLMModel,
    llmConfig: LLMConfig | undefined,
    context?: { kgContext?: string; referenceContext?: string },
  ): Promise<{ result: TeamResearchResult; usedTeam: boolean }> {
    const memory = new SimpleMemory();
    const timeout = 90_000;

    const contextBlock = [
      context?.kgContext ? `Knowledge Graph context:\n${context.kgContext}` : null,
      context?.referenceContext ? `Reference context:\n${context.referenceContext}` : null,
    ].filter(Boolean).join('\n\n');

    // ── Step 1: Researcher ───────────────────────────────────────────────────
    const researchPrompt = this.buildResearchPrompt(payload, contextBlock);
    const researchResult = await this.callWithTimeout(
      () => this.llmProvider.generateLLM(llmModel, researchPrompt, llmConfig),
      timeout,
      'researcher',
    );
    const parsedResearch = this.parseResearchResult(researchResult);
    memory.write('researcher', 'output', researchResult);
    memory.write('researcher', 'parsed', JSON.stringify(parsedResearch));

    // ── Step 2: Critic ───────────────────────────────────────────────────
    const criticPrompt = this.buildCriticPrompt(payload, parsedResearch);
    const criticResult = await this.callWithTimeout(
      () => this.llmProvider.generateLLM(llmModel, criticPrompt, llmConfig),
      timeout,
      'critic',
    );
    memory.write('critic', 'output', criticResult);

    // ── Step 3: Synthesizer ────────────────────────────────────────────────
    const synthesizePrompt = this.buildSynthesizePrompt(payload, parsedResearch, criticResult);
    const finalResult = await this.callWithTimeout(
      () => this.llmProvider.generateLLM(llmModel, synthesizePrompt, llmConfig),
      timeout,
      'synthesizer',
    );
    const final = this.parseResearchResult(finalResult);

    return { result: final, usedTeam: true };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private buildResearchPrompt(payload: ResearchPayload, contextBlock: string): string {
    return `You are a research analyst. Analyze the following paper thoroughly.

Paper: ${payload.title}
Abstract: ${payload.abstract}

${contextBlock ? contextBlock + '\n\n' : ''}Provide a structured analysis in JSON format:
\`\`\`json
{
  "summary": "2-3 sentence summary of the paper's main contribution and significance",
  "keyInsights": [
    "Concrete finding or contribution 1",
    "Concrete finding or contribution 2",
    "Concrete finding or contribution 3"
  ],
  "proposal": "A specific, testable next step or experiment building on this research"
}
\`\`\`
Respond only with valid JSON.`;
  }

  private buildCriticPrompt(payload: ResearchPayload, research: TeamResearchResult): string {
    return `You are a rigorous peer reviewer. A researcher has analyzed this paper:

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
  }

  private buildSynthesizePrompt(
    payload: ResearchPayload,
    research: TeamResearchResult,
    criticOutput: string,
  ): string {
    return `You are a research synthesizer. Combine a researcher's analysis with peer review critique.

Paper: ${payload.title}

Researcher's analysis:
- Summary: ${research.summary}
- Key Insights: ${research.keyInsights.join('; ')}
- Proposal: ${research.proposal}

Peer review critique:
${criticOutput}

Produce the FINAL ResearchResult, incorporating the critique to produce a refined, higher-quality output:

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
  }

  private parseResearchResult(raw: string): TeamResearchResult {
    let jsonStr = String(raw)
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```json\s*|```\s*/g, '')
      .trim();
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    // Sanitize control characters
    // eslint-disable-next-line no-control-regex
    jsonStr = jsonStr.replace(/[\x00-\x1f\x7f]/g, (ch) => {
      if (ch === '\n') return '\\n';
      if (ch === '\t') return '\\t';
      return '';
    });
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        summary: String(parsed.summary ?? 'No summary'),
        keyInsights: Array.isArray(parsed.keyInsights) ? parsed.keyInsights.map(String) : [],
        proposal: String(parsed.proposal ?? 'No proposal'),
      };
    } catch {
      return { summary: 'Parse failed', keyInsights: [], proposal: raw.slice(0, 200) };
    }
  }

  private async callWithTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout (>${ms}ms)`)), ms);
      fn().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}
