/**
 * ResearcherNode — first step in the multi-agent research pipeline.
 * Takes the paper payload from state and produces an initial research analysis.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { buildMedicalResearcherPrompt } from '../prompts/medical/medical-researcher';
import { renderMissionBriefForPrompt } from '../../mission-context-state';
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

    const meta = (workOrder.metadata ?? {}) as Record<string, unknown>;
    const paperDoi = typeof meta['paperDoi'] === 'string' ? meta['paperDoi'] : undefined;
    const relatedDois = Array.isArray(meta['relatedDois'])
      ? (meta['relatedDois'] as unknown[]).filter((d): d is string => typeof d === 'string')
      : undefined;

    const prompt = buildMedicalResearcherPrompt({
      title: payload.title,
      abstract: payload.abstract,
      doi: paperDoi,
      kgContext,
      referenceContext,
      relatedDois,
      missionContext: renderMissionBriefForPrompt(),
    });

    try {
      const output = await this.llmProvider.generateLLM(
        state.config?.llmModel ?? { provider: 'ollama', modelId: 'qwen2.5-3b' } as any,
        prompt,
        state.config?.llmConfig,
        { forceJson: true },
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
