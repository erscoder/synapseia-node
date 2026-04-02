/**
 * Request Peer Review Tool
 * Sprint E — A2A Client Integration
 *
 * LangGraph tool that requests a peer review via A2A.
 * Selects the best peer for the review based on tier/domain.
 */

import { Injectable } from '@nestjs/common';
import type { ToolDef, ToolResult } from './types';
import { PeerSelectorService } from '../../../a2a/client/peer-selector.service';
import { A2AClientService } from '../../../a2a/client/a2a-client.service';

@Injectable()
export class RequestPeerReviewTool {
  readonly def: ToolDef = {
    name: 'request_peer_review',
    description: 'Request a peer review of work (code, research, or proposal) from another node. The peer will evaluate quality and provide feedback. Best for: code reviews, research validation, proposal critique.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Content to be reviewed (code, text, proposal)',
        },
        contentType: {
          type: 'string',
          description: 'Type of content: code, research, proposal, document',
        },
        reviewCriteria: {
          type: 'string',
          description: 'Specific criteria to evaluate (optional)',
        },
        preferredDomain: {
          type: 'string',
          description: 'Preferred domain of the reviewing peer (optional)',
        },
        reason: {
          type: 'string',
          description: 'Why a peer review is needed (for logging)',
        },
      },
      required: ['content', 'contentType'],
    },
  };

  constructor(
    private readonly peerSelector: PeerSelectorService,
    private readonly a2aClient: A2AClientService,
  ) {}

  async execute(params: {
    content: string;
    contentType: string;
    reviewCriteria?: string;
    preferredDomain?: string;
    reason?: string;
    ourPeerId: string;
    ourPrivateKeyHex: string;
  }): Promise<ToolResult> {
    const start = Date.now();

    try {
      const peer = this.peerSelector.selectPeer('peer_review', params.preferredDomain);

      if (!peer) {
        return {
          success: false,
          data: null,
          latencyMs: Date.now() - start,
          error: 'No live peer available for peer_review',
        };
      }

      const payload = {
        content: params.content,
        contentType: params.contentType,
        reviewCriteria: params.reviewCriteria,
        requestedBy: params.ourPeerId,
        reason: params.reason,
      };

      const result = await this.a2aClient.sendTask(
        peer.a2aUrl,
        'peer_review',
        payload,
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
