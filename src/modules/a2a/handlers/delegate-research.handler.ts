/**
 * Delegate Research Handler
 * Sprint E — A2A Server for Synapseia Node
 *
 * Handles delegated WorkOrder execution requests from other nodes.
 * Uses A2AClientService to potentially delegate further or coordinate.
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class DelegateResearchHandler {
  /**
   * Handle a delegate research request.
   * payload: { workOrder: WorkOrder, coordinatorUrl: string }
   * Returns: { summary: string, keyInsights: string[], proposal: string }
   *
   * NOTE: Full execution via LangGraph is Sprint E.
   * This handler is called by A2AServer when another node sends a delegate_research task.
   */
  async handle(
    payload: Record<string, unknown>,
    _ourPeerId?: string,
    _ourPrivateKey?: string,
  ): Promise<unknown> {
    const workOrder = payload['workOrder'];
    const coordinatorUrl = payload['coordinatorUrl'] as string | undefined;

    if (!workOrder) {
      throw new Error('delegate_research payload requires workOrder');
    }

    const workOrderId = typeof workOrder === 'object' && workOrder !== null
      ? (workOrder as Record<string, unknown>)['id'] ?? 'unknown'
      : 'unknown';

    console.log(`[A2A DelegateResearch] Received work order delegation`, {
      workOrderId,
      coordinatorUrl,
    });

    return {
      summary: 'Research delegated successfully (stub)',
      keyInsights: [],
      proposal: 'Full LangGraph execution in Sprint E',
      status: 'pending_sprint_e',
      workOrderId,
    };
  }
}
