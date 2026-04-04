/**
 * Execute Research Node with ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import type { AgentState, WorkOrder, ResearchResult } from '../state';
import type { ReActThought } from '../tools/types';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolRunnerService } from '../tools/tool-runner.service';
import { LangGraphLlmService } from '../llm.service';
import { buildReActPrompt } from '../prompts/react';
import logger from '../../../../utils/logger';

@Injectable()
export class ExecuteResearchNode {
  constructor(
    private readonly execution: WorkOrderExecutionHelper,
    private readonly evaluation: WorkOrderEvaluationHelper,
    private readonly toolRunner: ToolRunnerService,
    private readonly toolRegistry: ToolRegistry,
    private readonly llmService: LangGraphLlmService,
  ) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, config, coordinatorUrl } = state;
    if (!selectedWorkOrder) {
      return { executionResult: { result: 'No work order selected', success: false }, researchResult: null };
    }

    logger.log(` Executing research with ReAct: ${selectedWorkOrder.title}`);

    try {
      const result = await this.runReActLoop(selectedWorkOrder, state);
      return {
        executionResult: {
          result: JSON.stringify({
            summary: result.summary,
            keyInsights: result.keyInsights,
            proposal: result.proposal,
            hypothesis: result.summary,
            metricType: 'coherence',
            metricValue: this.evaluation.scoreResearchResult(result),
            proof: result.proposal,
          }),
          success: true,
        },
        researchResult: result,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(` Research ReAct execution failed: ${msg}`);

      // Fallback: use legacy executor
      logger.log(` Falling back to legacy executor`);
      const research = await this.execution.executeResearchWorkOrder(
        selectedWorkOrder, config.llmModel, config.llmConfig, coordinatorUrl, state.peerId,
      );

      return {
        executionResult: {
          result: JSON.stringify({
            summary: research.result.summary,
            keyInsights: research.result.keyInsights,
            proposal: research.result.proposal,
            hypothesis: research.result.summary,
            metricType: 'coherence',
            metricValue: research.success ? this.evaluation.scoreResearchResult(research.result) : 0.0,
            proof: research.result.proposal,
          }),
          success: research.success,
        },
        researchResult: research.result,
      };
    }
  }

  private async runReActLoop(wo: WorkOrder, state: AgentState): Promise<ResearchResult> {
    const ctx = this.toolRunner.createExecutionContext();
    const observations: Array<{ tool: string; result: string }> = [];
    const plan = state.executionPlan?.map(s => `${s.id}. ${s.description}`) ?? ['Analyze the paper'];

    // Register tool definitions for prompt
    this.registerTools();
    const toolList = this.toolRegistry.toPromptString();

    let iterationCount = 0;
    const MAX_ITERATIONS = 7; // safety guard

    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      const prompt = buildReActPrompt(
        { title: wo.title, abstract: this.extractAbstract(wo) },
        plan,
        toolList,
        observations,
      );

      const raw = await this.llmService.generate(state.config.llmModel, prompt, state.config.llmConfig);
      const thought = this.parseReActResponse(raw);

      if (thought.action === 'use_tool' && thought.toolCall && ctx.callCount < ctx.maxCalls) {
        ctx.callCount++;
        const toolResult = await this.toolRunner.run({
          ...thought.toolCall,
          // pass coordinatorUrl for tools that need it
          params: { ...thought.toolCall.params, coordinatorUrl: state.coordinatorUrl },
        });
        observations.push({
          tool: thought.toolCall.toolName,
          result: toolResult.success ? JSON.stringify(toolResult.data).slice(0, 500) : `Error: ${toolResult.error}`,
        });
        continue;
      }

      // action === 'generate_answer' or max tools reached
      return this.buildResearchResult(thought.answer ?? raw, wo.title);
    }

    // Max iterations reached - build result from last response
    throw new Error('Max ReAct iterations reached without generating answer');
  }

  private registerTools(): void {
    // Import tools to get their definitions
    const { SearchCorpusTool } = require('../tools/search-corpus.tool');
    const { QueryKgTool } = require('../tools/query-kg.tool');
    const { GenerateEmbeddingTool } = require('../tools/generate-embedding.tool');

    // Only register if not already registered
    if (this.toolRegistry.getAll().length === 0) {
      this.toolRegistry.register(new SearchCorpusTool().def);
      this.toolRegistry.register(new QueryKgTool().def);
      this.toolRegistry.register(new GenerateEmbeddingTool().def);
    }
  }

  private parseReActResponse(raw: string): ReActThought {
    try {
      // Strip markdown code fences if present
      let jsonStr = raw.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();

      // Strip <think>...</think> blocks (reasoning models)
      jsonStr = jsonStr.replace(/[\s\S]*?<\/think>/gi, '');

      // Strip leading literal \n sequences (LLM sometimes outputs \n before JSON)
      jsonStr = jsonStr.replace(/^\\n+/, '');

      // Sanitize control characters inside JSON string values (tabs, newlines, etc.)
      // eslint-disable-next-line no-control-regex
      jsonStr = jsonStr.replace(/[\x00-\x1f\x7f]/g, (ch) => {
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        return '';
      });

      const parsed = JSON.parse(jsonStr) as ReActThought;

      // Validate required fields
      if (!parsed.thought || !parsed.action) {
        throw new Error('Missing required fields: thought, action');
      }

      if (parsed.action === 'use_tool' && !parsed.toolCall) {
        throw new Error('Missing toolCall for use_tool action');
      }

      if (parsed.action === 'generate_answer' && !parsed.answer) {
        // If answer is missing but action is generate_answer, use the raw response
        parsed.answer = jsonStr;
      }

      return parsed;
    } catch (error) {
      logger.warn(` Failed to parse ReAct response: ${(error as Error).message}. Treating as direct answer.`);
      // Fallback: treat entire response as the answer
      return {
        thought: 'Failed to parse structured response, treating as direct answer',
        action: 'generate_answer',
        answer: raw,
      };
    }
  }

  private extractAbstract(wo: WorkOrder): string {
    // Try to parse description as JSON with abstract
    try {
      const payload = JSON.parse(wo.description);
      if (payload.abstract) {
        return payload.abstract;
      }
    } catch {
      // Not JSON, use description as abstract
    }
    return wo.description ?? '';
  }

  private buildResearchResult(answer: string | Record<string, unknown>, title: string): ResearchResult {
    // Ensure answer is a string
    if (typeof answer !== 'string') {
      // If it's already a structured object, try to use it directly
      if (answer && typeof answer === 'object') {
        return {
          summary: String((answer as any).summary || `Analysis of ${title}`),
          keyInsights: Array.isArray((answer as any).keyInsights) ? (answer as any).keyInsights : [],
          proposal: String((answer as any).proposal || (answer as any).hypothesis || 'See summary'),
        };
      }
      answer = String(answer);
    }
    // Try to parse as JSON result
    try {
      // Strip markdown and thinking blocks
      let jsonStr = answer
        .replace(/```json\s*/g, '')
        .replace(/```\s*$/g, '')
        .replace(/[\s\S]*?<\/think>/gi, '')
        .trim();

      // Sanitize control characters
      // eslint-disable-next-line no-control-regex
      jsonStr = jsonStr.replace(/[\x00-\x1f\x7f]/g, (ch) => {
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        return '';
      });

      // Extract JSON object
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr);

      // Validate and normalize result structure
      return {
        summary: parsed.summary || `Analysis of ${title}`,
        keyInsights: Array.isArray(parsed.keyInsights) ? parsed.keyInsights : [],
        proposal: parsed.proposal || parsed.hypothesis || 'No proposal generated',
      };
    } catch {
      // Fallback: create structured result from raw answer
      const answerStr = typeof answer === 'string' ? answer : JSON.stringify(answer);
      const lines = answerStr.split('\n').filter(l => l.trim());
      return {
        summary: lines[0] || `Analysis of ${title}`,
        keyInsights: lines.slice(1, 6),
        proposal: lines.slice(6).join(' ') || 'See summary for details',
      };
    }
  }
}
