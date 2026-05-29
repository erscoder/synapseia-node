/**
 * Tool Runner Service for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable, Optional } from '@nestjs/common';
import { startActiveObservation } from '@langfuse/tracing';
import logger from '../../../../utils/logger';
import type { ToolCall, ToolResult } from './types';
import { SearchCorpusTool } from './search-corpus.tool';
import { QueryKgTool } from './query-kg.tool';
import { GenerateEmbeddingTool } from './generate-embedding.tool';
import { DelegateToPeerTool } from './delegate-peer.tool';
import { RequestPeerReviewTool } from './request-peer-review.tool';

/** Bug I: thrown when a corpus/KG tool is called without a usable `topic`. */
const MISSING_TOPIC_REASON = 'missing_topic';

/**
 * Tools that are ALWAYS registered + credentialed for every execution context
 * (the medical/research tools wired as required ctor deps). The A2A tools
 * (`delegate_to_peer`, `request_peer_review`) are NOT here — they are optional
 * and only allowed when their helper was actually injected (A2A enabled).
 */
const ALWAYS_REGISTERED_TOOLS = [
  'search_reference_corpus',
  'query_knowledge_graph',
  'generate_embedding',
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

@Injectable()
export class ToolRunnerService {
  private readonly TIMEOUT_MS = 10_000;
  private readonly MAX_CALLS_PER_EXECUTION = 5;

  /**
   * Confused-deputy guard: the explicit ALLOWLIST of tool names this instance
   * is actually credentialed to dispatch. Built once from the injected deps —
   * the optional A2A tools are only added when their helper was provided (A2A
   * enabled), so the ReAct loop can never coax an uncredentialed dispatch by
   * emitting an A2A tool name on a node where A2A is off. Any name outside this
   * set is rejected at the boundary (fail-closed) instead of reaching a handler
   * that would run without the credentials/context the loop never injected.
   */
  private readonly allowedTools: ReadonlySet<string>;

  constructor(
    private readonly searchCorpusTool: SearchCorpusTool,
    private readonly queryKgTool: QueryKgTool,
    private readonly generateEmbeddingTool: GenerateEmbeddingTool,
    @Optional() private readonly delegateToPeerTool?: DelegateToPeerTool,
    @Optional() private readonly requestPeerReviewTool?: RequestPeerReviewTool,
  ) {
    const allowed = new Set<string>(ALWAYS_REGISTERED_TOOLS);
    if (this.delegateToPeerTool) allowed.add('delegate_to_peer');
    if (this.requestPeerReviewTool) allowed.add('request_peer_review');
    this.allowedTools = allowed;
  }

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

    // Confused-deputy boundary: reject any tool not in the allowlist registered
    // for THIS execution context (the always-registered medical/research tools
    // plus only the A2A tools whose helper was injected). Fail closed before the
    // dispatch switch so an unregistered or A2A-disabled tool name can never
    // reach a handler the loop did not credential. The list of allowed names is
    // included in the error so the ReAct loop can self-correct next iteration.
    if (!this.allowedTools.has(toolName)) {
      throw new Error(
        `Tool '${toolName}' is not registered for this execution context. ` +
          `Allowed tools: ${[...this.allowedTools].join(', ')}.`,
      );
    }

    switch (toolName) {
      case 'search_reference_corpus': {
        const { topic, limit, coordinatorUrl } = params as { topic: string; limit?: number; coordinatorUrl: string };
        if (!coordinatorUrl) throw new Error('coordinatorUrl is required for search_reference_corpus');
        // Bug I: short-circuit when the ReAct LLM emits a tool call without
        // a usable `topic`. Surfacing this as a structured failure lets the
        // ReAct loop see the miss and adjust on the next iteration; before
        // this guard the request reached the corpus fetcher with topic
        // `"undefined"` and produced misleading "Failed to fetch context for
        // topic 'undefined'" warnings on every call.
        if (!isNonEmptyString(topic)) {
          logger.info(`[ToolRunner] skipping ${toolName} — missing/invalid topic arg`);
          return { success: false, reason: MISSING_TOPIC_REASON };
        }
        return this.searchCorpusTool.execute({ topic, limit }, coordinatorUrl);
      }
      case 'query_knowledge_graph': {
        const { topic, missionId, coordinatorUrl } = params as { topic: string; missionId?: string; coordinatorUrl: string };
        if (!coordinatorUrl) throw new Error('coordinatorUrl is required for query_knowledge_graph');
        if (!isNonEmptyString(topic)) {
          logger.info(`[ToolRunner] skipping ${toolName} — missing/invalid topic arg`);
          return { success: false, reason: MISSING_TOPIC_REASON };
        }
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
