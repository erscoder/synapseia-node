/**
 * Tool Runner Service for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable } from '@nestjs/common';
import type { ToolCall, ToolResult } from './types';
import { SearchCorpusTool } from './search-corpus.tool';
import { QueryKgTool } from './query-kg.tool';
import { GenerateEmbeddingTool } from './generate-embedding.tool';

@Injectable()
export class ToolRunnerService {
  private readonly TIMEOUT_MS = 10_000;
  private readonly MAX_CALLS_PER_EXECUTION = 5;

  constructor(
    private readonly searchCorpusTool: SearchCorpusTool,
    private readonly queryKgTool: QueryKgTool,
    private readonly generateEmbeddingTool: GenerateEmbeddingTool,
  ) {}

  async run(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const result = await this.executeWithTimeout(call);
      return { success: true, data: result, latencyMs: Date.now() - start };
    } catch (error) {
      return { success: false, data: null, latencyMs: Date.now() - start, error: (error as Error).message };
    }
  }

  private async executeWithTimeout(call: ToolCall): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const result = await this.executeTool(call);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  private async executeTool(call: ToolCall): Promise<unknown> {
    const { toolName, params } = call;

    switch (toolName) {
      case 'search_reference_corpus': {
        const { topic, limit, coordinatorUrl } = params as { topic: string; limit?: number; coordinatorUrl: string };
        if (!coordinatorUrl) throw new Error('coordinatorUrl is required for search_reference_corpus');
        return this.searchCorpusTool.execute({ topic, limit }, coordinatorUrl);
      }
      case 'query_knowledge_graph': {
        const { topic, missionId, coordinatorUrl } = params as { topic: string; missionId?: string; coordinatorUrl: string };
        if (!coordinatorUrl) throw new Error('coordinatorUrl is required for query_knowledge_graph');
        return this.queryKgTool.execute({ topic, missionId }, coordinatorUrl);
      }
      case 'generate_embedding': {
        const { text } = params as { text: string };
        return this.generateEmbeddingTool.execute({ text });
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // Call this at the start of each ReAct execution to reset counter
  createExecutionContext(): { callCount: number; maxCalls: number } {
    return { callCount: 0, maxCalls: this.MAX_CALLS_PER_EXECUTION };
  }
}
