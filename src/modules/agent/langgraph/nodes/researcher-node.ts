/**
 * ResearcherNode — first step in the multi-agent research pipeline.
 * Takes the paper payload from state and produces an initial research analysis.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import logger from '../../../../utils/logger';

@Injectable()
export class ResearcherNode {
  constructor(
    private readonly llmProvider: LlmProviderHelper,
    private readonly coordinator: WorkOrderCoordinatorHelper,
  ) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const workOrder = state.selectedWorkOrder;
    if (!workOrder) {
      logger.warn('[ResearcherNode] No work order selected');
      return { researcherOutput: '' };
    }

    const payload = this.extractPayload(workOrder.description, workOrder.title);
    if (!payload) {
      logger.warn('[ResearcherNode] No valid research payload');
      return { researcherOutput: '' };
    }

    // Fetch context from coordinator
    let kgContext = '';
    let referenceContext = '';
    if (state.coordinatorUrl) {
      const topic = payload.title.split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
      try {
        kgContext = await this.coordinator.fetchKGraphContext(state.coordinatorUrl, topic) ?? '';
        referenceContext = await this.coordinator.fetchReferenceContext(state.coordinatorUrl, topic) ?? '';
      } catch { /* ignore */ }
    }

    const contextBlock = [
      kgContext ? `Knowledge Graph context:\n${kgContext}` : null,
      referenceContext ? `Reference context:\n${referenceContext}` : null,
    ].filter(Boolean).join('\n\n');

    const prompt = `You are a research analyst. Analyze the following paper thoroughly.

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

    try {
      const output = await this.llmProvider.generateLLM(
        state.config?.llmModel ?? { provider: 'ollama', modelId: 'qwen2.5-3b' } as any,
        prompt,
        undefined,
        undefined,
      );
      logger.log(`[ResearcherNode] Generated research output (${output.length} chars)`);
      return {
        researcherOutput: output,
        researchPayload: payload,
      };
    } catch (err) {
      logger.error('[ResearcherNode] LLM call failed:', (err as Error).message);
      return { researcherOutput: '' };
    }
  }

  private extractPayload(description: string, title: string): { title: string; abstract: string } | null {
    try {
      const p = JSON.parse(description);
      if (p.title && p.abstract) return { title: p.title, abstract: p.abstract };
    } catch { /* not JSON */ }
    if (title && description) return { title, abstract: description.slice(0, 2000) };
    return null;
  }
}
