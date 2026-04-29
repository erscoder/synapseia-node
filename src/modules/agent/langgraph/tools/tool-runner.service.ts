/**
 * Tool Runner Service for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable, Optional } from '@nestjs/common';
import { startActiveObservation } from '@langfuse/tracing';
import type { ToolCall, ToolResult } from './types';
import { SearchCorpusTool } from './search-corpus.tool';
import { QueryKgTool } from './query-kg.tool';
import { GenerateEmbeddingTool } from './generate-embedding.tool';
import { DelegateToPeerTool } from './delegate-peer.tool';
import { RequestPeerReviewTool } from './request-peer-review.tool';

@Injectable()
export class ToolRunnerService {
  private readonly TIMEOUT_MS = 10_000;
  private readonly MAX_CALLS_PER_EXECUTION = 5;

  constructor(
    private readonly searchCorpusTool: SearchCorpusTool,
    private readonly queryKgTool: QueryKgTool,
    private readonly generateEmbeddingTool: GenerateEmbeddingTool,
    @Optional() private readonly delegateToPeerTool?: DelegateToPeerTool,
    @Optional() private readonly requestPeerReviewTool?: RequestPeerReviewTool,
  ) {}

  async run(call: ToolCall): Promise<ToolResult> {
    if (!process.env.LANGFUSE_SECRET_KEY) {
      return this.executeInternal(call);
    }
    return startActiveObservation(`tool.${call.toolName}`, async (span) => {
      span.update({ input: call });
      const result = await this.executeInternal(call);
      span.update({ output: result });
      return result;
    });
  }

  private async executeInternal(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const data = await this.executeWithTimeout(call);
      return { success: true, data, latencyMs: Date.now() - start };
    } catch (error) {
      return { success: false, data: null, latencyMs: Date.now() - start, error: (error as Error).message };
    }
  }

  private async executeWithTimeout(call: ToolCall): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    try {
      return await this.executeTool(call);
    } finally {
      clearTimeout(timeoutId);
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
      case 'delegate_to_peer': {
        if (!this.delegateToPeerTool) throw new Error('DelegateToPeerTool not available (A2A not enabled)');
        return this.delegateToPeerTool.execute(params as {
          capability: string;
          taskType: string;
          payload: Record<string, unknown>;
          preferredDomain?: string;
          reason?: string;
          ourPeerId: string;
          ourPrivateKeyHex: string;
        });
      }
      case 'request_peer_review': {
        if (!this.requestPeerReviewTool) throw new Error('RequestPeerReviewTool not available (A2A not enabled)');
        return this.requestPeerReviewTool.execute(params as {
          content: string;
          contentType: string;
          reviewCriteria?: string;
          preferredDomain?: string;
          reason?: string;
          ourPeerId: string;
          ourPrivateKeyHex: string;
        });
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
