/**
 * Plan Execution Node
 * Sprint B - LLM generates multi-step plan for research work orders
 */

import { Injectable } from '@nestjs/common';
import type { AgentState, ExecutionStep } from '../state';
import { LangGraphLlmService } from '../llm.service';
import { buildPlanningPrompt, DEFAULT_EXECUTION_PLAN } from '../prompts/plan';
import logger from '../../../../utils/logger';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { parseLlmJson } from '../../../../shared/parse-llm-json';

@Injectable()
export class PlanExecutionNode {
  constructor(
    private readonly llmService: LangGraphLlmService,
    private readonly execution: WorkOrderExecutionHelper,
  ) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, relevantMemories, config } = state;

    // Only plan for research work orders - fast path for others
    if (!selectedWorkOrder || selectedWorkOrder.type !== 'RESEARCH') {
      logger.log('[PlanExecutionNode] Skipping planning for non-research WO');
      return {
        executionPlan: [],
        currentStepIndex: 0
      };
    }

    try {
      // Extract research payload — coordinator sends plain-text descriptions with
      // metadata.paperTitle/paperAbstract, not JSON. extractResearchPayload handles
      // all 3 formats (legacy JSON, metadata fields, plain "Abstract:\n..." text).
      const extracted = this.execution.extractResearchPayload(selectedWorkOrder);
      const payload = extracted ?? { title: selectedWorkOrder.title, abstract: '' };
      if (!extracted) {
        logger.warn('[PlanExecutionNode] Could not extract research payload, using title only');
      }

      // Build the planning prompt
      const memoriesText = this.formatMemories(relevantMemories || []);
      const prompt = buildPlanningPrompt({
        title: payload.title || selectedWorkOrder.title,
        abstract: payload.abstract || '',
        memories: memoriesText,
      });

      const llmResponse = await this.llmService.generateJSON(
        config.llmModel,
        prompt,
        config.llmConfig
      );

      // Parse the execution plan
      const executionPlan = this.parseExecutionPlan(llmResponse);

      logger.log(`[PlanExecutionNode] Generated plan with ${executionPlan.length} steps for research WO: ${selectedWorkOrder.title}`);

      return {
        executionPlan,
        currentStepIndex: 0,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Fallback to DEFAULT_EXECUTION_PLAN below recovers cleanly — the WO
      // continues with a generic plan, no work is lost. Warn keeps it
      // visible for plan-quality tracking without faking an outage.
      logger.warn(`[PlanExecutionNode] Failed to generate plan, using default: ${msg}`);

      // Fallback to default plan
      return {
        executionPlan: DEFAULT_EXECUTION_PLAN,
        currentStepIndex: 0,
      };
    }
  }

  /**
   * Format memories for the prompt
   */
  private formatMemories(memories: { content: string; importance: number }[]): string {
    if (memories.length === 0) {
      return 'None';
    }
    return memories
      .map(m => `- ${m.content} (importance: ${m.importance.toFixed(2)})`)
      .join('\n');
  }

  /**
   * Parse LLM response into execution steps
   */
  private parseExecutionPlan(jsonText: string): ExecutionStep[] {
    try {
      // parseLlmJson handles trailing prose / stacked structures emitted
      // by providers that ignore response_format (MiniMax cloud, raw
      // local Llama, etc.). Plans are arrays, so the helper's structure
      // extractor recovers `[...]` as well as `{...}`.
      const result = parseLlmJson<ExecutionStep[]>(jsonText);
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? 'JSON parse failed');
      }
      const parsed = result.value;

      // Validate it's an array
      if (!Array.isArray(parsed)) {
        throw new Error('Response is not an array');
      }

      // Validate each step has required fields and valid action
      const validActions = ['fetch_context', 'analyze_paper', 'cross_reference', 'generate_hypothesis', 'peer_review_prep'];
      const validatedSteps = parsed.filter(step => {
        return (
          typeof step.id === 'string' &&
          typeof step.action === 'string' &&
          validActions.includes(step.action) &&
          typeof step.description === 'string'
        );
      });

      if (validatedSteps.length === 0) {
        throw new Error('No valid steps found in response');
      }

      // Limit to 3-5 steps
      return validatedSteps.slice(0, 5);
    } catch {
      // Plan-parse falling back to DEFAULT_EXECUTION_PLAN is benign and
      // very common with small local LLMs: log at info so this stops
      // dominating the warning histogram. Persistent failure is captured
      // by the outer logger.warn at line 68.
      logger.info('[PlanExecutionNode] Failed to parse plan, using default');
      return DEFAULT_EXECUTION_PLAN;
    }
  }
}
