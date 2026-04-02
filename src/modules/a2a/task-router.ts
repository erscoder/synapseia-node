/**
 * Task Router
 * Sprint D — A2A Server for Synapseia Node
 *
 * Dispatches incoming A2A tasks to the appropriate handler based on task type.
 */

import { Injectable } from '@nestjs/common';
import type { A2ATask, A2ATaskResult, A2ATaskType } from './types';
import { PeerReviewHandler } from './handlers/peer-review.handler';
import { EmbeddingHandler } from './handlers/embedding.handler';
import { HealthCheckHandler } from './handlers/health-check.handler';
import { DelegateResearchHandler } from './handlers/delegate-research.handler';

@Injectable()
export class TaskRouter {
  constructor(
    private readonly peerReviewHandler: PeerReviewHandler,
    private readonly embeddingHandler: EmbeddingHandler,
    private readonly healthCheckHandler: HealthCheckHandler,
    private readonly delegateResearchHandler: DelegateResearchHandler,
  ) {}

  /**
   * Route an A2A task to the appropriate handler and return the result.
   */
  async route(task: A2ATask): Promise<A2ATaskResult> {
    const start = Date.now();

    try {
      const data = await this.routeTask(task);
      return {
        taskId: task.id,
        success: true,
        data,
        processingMs: Date.now() - start,
      };
    } catch (err) {
      return {
        taskId: task.id,
        success: false,
        data: null,
        error: (err as Error).message,
        processingMs: Date.now() - start,
      };
    }
  }

  private async routeTask(task: A2ATask): Promise<unknown> {
    switch (task.type) {
      case 'peer_review':
        return this.peerReviewHandler.handle(task.payload);

      case 'embedding_request':
        return this.embeddingHandler.handle(task.payload);

      case 'health_check':
        return this.healthCheckHandler.handle();

      case 'delegate_research':
        return this.delegateResearchHandler.handle(task.payload);

      case 'knowledge_query':
        // Fallback: not implemented yet
        throw new Error(`knowledge_query handler not yet implemented`);

      default: {
        const _exhaustive: never = task.type;
        throw new Error(`Unknown task type: ${_exhaustive}`);
      }
    }
  }
}
