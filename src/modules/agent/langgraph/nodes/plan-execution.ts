/**
 * Plan Execution Node
 * Sprint B - LLM generates multi-step plan for research work orders
 */

import { Injectable } from '@nestjs/common';
import type { AgentState, ExecutionStep } from '../state';
import type { LangGraphLlmService } from '../llm.service';
import { buildPlanningPrompt, DEFAULT_EXECUTION_PLAN } from '../prompts/plan';
import logger from '../../../../utils/logger';
import type { ResearchPayload } from '../../work-order-agent';

@Injectable()
export class PlanExecutionNode {
  constructor(private readonly llmService: LangGraphLlmService) {}

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
      // Extract research payload from description
      let payload: ResearchPayload;
      try {
        payload = JSON.parse(selectedWorkOrder.description) as ResearchPayload;
      } catch {
        logger.warn('[PlanExecutionNode] Failed to parse research payload, using defaults');
        payload = { title: selectedWorkOrder.title, abstract: '' };
      }

      // Build the planning prompt
      const memoriesText = this.formatMemories(relevantMemories || []);
      const prompt = buildPlanningPrompt({
        title: payload.title || selectedWorkOrder.title,
        abstract: payload.abstract || '',
        memories: memoriesText,
      });

      // Call LLM for plan generation
      const llmResponse = await this.llmService.generate(
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
      logger.error(`[PlanExecutionNode] Failed to generate plan: ${msg}`);
      
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
      const parsed = JSON.parse(jsonText) as ExecutionStep[];
      
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
      logger.warn('[PlanExecutionNode] Failed to parse plan, using default');
      return DEFAULT_EXECUTION_PLAN;
    }
  }
}
