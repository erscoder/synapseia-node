/**
 * Knowledge Query Handler
 * Sprint D — A2A Server for Synapseia Node
 *
 * Handles knowledge_query A2A tasks — queries the knowledge graph for
 * broader scientific context by delegating to the coordinator's KG endpoint.
 */

import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../agent/work-order/work-order.coordinator';

export interface KnowledgeQueryPayload {
  topic: string;
  missionId?: string;
}

@Injectable()
export class KnowledgeQueryHandler {
  private readonly coordinatorHelper = new WorkOrderCoordinatorHelper();

  /**
   * Handle a knowledge_query A2A task.
   * payload: { topic: string, missionId?: string }
   * Returns: { context: string, topic: string, missionId?: string }
   */
  async handle(payload: Record<string, unknown>): Promise<unknown> {
    const topic = payload['topic'] as string;
    const missionId = payload['missionId'] as string | undefined;

    if (!topic || typeof topic !== 'string') {
      throw new Error('knowledge_query payload requires topic (string)');
    }

    // Default coordinator URL — in A2A context, use the configured coordinator
    const coordinatorUrl = process.env.COORDINATOR_URL ?? 'http://localhost:3701';

    try {
      const context = await this.coordinatorHelper.fetchKGraphContext(
        coordinatorUrl,
        topic,
        missionId,
      );
      return {
        context,
        topic,
        missionId: missionId ?? null,
      };
    } catch (err) {
      return {
        error: (err as Error).message,
        topic,
        missionId: missionId ?? null,
      };
    }
  }
}
