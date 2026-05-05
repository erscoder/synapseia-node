/**
 * Delegate To Peer Tool
 * Sprint E — A2A Client Integration
 *
 * LangGraph tool that delegates a subtask to a specialized peer node via A2A.
 * Used when another node is better suited (higher tier, same domain, etc.).
 */

import { Injectable } from '@nestjs/common';
import type { ToolDef, ToolResult } from './types';
import { PeerSelectorService } from '../../../a2a/client/peer-selector.service';
import { A2AClientService } from '../../../a2a/client/a2a-client.service';

@Injectable()
export class DelegateToPeerTool {
  readonly def: ToolDef = {
    name: 'delegate_to_peer',
    description: 'Delegate a subtask to a specialized peer node via A2A. Use when another node is better suited (higher tier, same domain, or specialized capability). Returns the result from the delegated node.',
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'The capability required (e.g. "llm", "embedding", "inference"). Higher-tier peers are preferred automatically by the selector via the nodes.tier column — do NOT pass "tier-N" here, it is not a capability value.',
        },
        taskType: {
          type: 'string',
          description: 'A2A task type: peer_review, embedding_request, delegate_research, knowledge_query',
        },
        payload: {
          type: 'object',
          description: 'Task payload to send to the peer',
        },
        preferredDomain: {
          type: 'string',
          description: 'Preferred domain for the peer (optional)',
        },
        reason: {
          type: 'string',
          description: 'Why this delegation is being made (for logging)',
        },
      },
      required: ['capability', 'taskType', 'payload'],
    },
  };

  constructor(
    private readonly peerSelector: PeerSelectorService,
    private readonly a2aClient: A2AClientService,
  ) {}

  async execute(params: {
    capability: string;
    taskType: string;
    payload: Record<string, unknown>;
    preferredDomain?: string;
    reason?: string;
    ourPeerId: string;
    ourPrivateKeyHex: string;
  }): Promise<ToolResult> {
    const start = Date.now();

    try {
      const peer = this.peerSelector.selectPeer(params.capability, params.preferredDomain);

      if (!peer) {
        return {
          success: false,
          data: null,
          latencyMs: Date.now() - start,
          error: `No live peer available with capability '${params.capability}'`,
        };
      }

      const result = await this.a2aClient.sendTask(
        peer.a2aUrl,
        params.taskType as import('../../../a2a/types').A2ATaskType,
        params.payload,
        params.ourPeerId,
        params.ourPrivateKeyHex,
      );

      return {
        success: result.success,
        data: result.data,
        latencyMs: result.processingMs,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        latencyMs: Date.now() - start,
        error: (error as Error).message,
      };
    }
  }
}
