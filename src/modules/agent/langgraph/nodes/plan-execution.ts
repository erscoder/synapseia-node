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

/**
 * Parse an LLM-emitted execution plan into `ExecutionStep[]`.
 *
 * Free function (not a class method) so it can be unit-tested directly
 * without standing up the surrounding NestJS class + DI graph. The class
 * `PlanExecutionNode.execute()` is the only production caller, which keeps
 * the warn-log telemetry contract owned by a single code path — outside
 * callers cannot bypass it because there is only one production caller
 * (the class itself) and that caller funnels through this function.
 *
 * `modelName` is passed through purely so the warn log can identify
 * the offending model when LLM output is non-parseable — visible
 * silent quality degradation was the original bug.
 */
export function parseExecutionPlan(jsonText: string, modelName = 'unknown'): ExecutionStep[] {
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
  } catch (err) {
    // Plan-parse falling back to DEFAULT_EXECUTION_PLAN is benign for
    // a single WO but a SUSTAINED stream of failures = silent quality
    // degradation (every research WO runs the default 3-step plan
    // instead of the LLM-tailored one). Warn keeps it visible in
    // log filters without faking a hard failure. Include the raw
    // output (head 500 + tail 200, ellipsised) so operators can see
    // WHAT the model emitted, the model name, and total prompt length.
    const reason = err instanceof Error ? err.message : String(err);
    const preview = truncateMiddle(jsonText ?? '', 500, 200);
    logger.warn(
      `[PlanExecutionNode] LLM plan parse failed (model=${modelName}, output_len=${(jsonText ?? '').length}, reason=${reason}): "${preview}" — falling back to default 3-step plan`,
    );
    return DEFAULT_EXECUTION_PLAN;
  }
}

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

      // Parse the execution plan via the free-function unit-test surface.
      // Class method delegates so there is exactly ONE plan-parse code
      // path in production — the warn-log telemetry contract cannot be
      // bypassed by an alternative caller.
      const executionPlan = parseExecutionPlan(llmResponse, config.llmModel);

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
}

/**
 * Truncate a string in the middle, keeping `headChars` at the start and
 * `tailChars` at the end with ` ... ` between. If the string already fits,
 * returns it verbatim.
 *
 * Exported for unit-test coverage of the boundary cases (input shorter
 * than head+tail, exactly head+tail, longer).
 */
export function truncateMiddle(s: string, headChars: number, tailChars: number): string {
  if (s.length <= headChars + tailChars) return s;
  return `${s.slice(0, headChars)} ... ${s.slice(-tailChars)}`;
}
