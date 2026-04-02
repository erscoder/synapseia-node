/**
 * Retrieve Memory Node
 * Sprint B - Fetches relevant memories from brain for the current work order
 */

import { Injectable } from '@nestjs/common';
import type { AgentState, MemoryEntry } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class RetrieveMemoryNode {
  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { brain, selectedWorkOrder } = state;

    // Handle missing brain gracefully
    if (!brain) {
      logger.warn('[RetrieveMemoryNode] No brain available, returning empty memories');
      return { relevantMemories: [] };
    }

    // Handle missing selected work order
    if (!selectedWorkOrder) {
      logger.warn('[RetrieveMemoryNode] No work order selected, returning empty memories');
      return { relevantMemories: [] };
    }

    // Get memories sorted by importance (descending), take top 5
    const relevantMemories = this.getTopMemoriesByImportance(brain.memory || [], 5);

    logger.log(`[RetrieveMemoryNode] Retrieved ${relevantMemories.length} relevant memories for WO: ${selectedWorkOrder.title}`);

    return { relevantMemories };
  }

  /**
   * Get top N memories sorted by importance (descending)
   */
  private getTopMemoriesByImportance(memories: MemoryEntry[], count: number): MemoryEntry[] {
    if (!memories || memories.length === 0) {
      return [];
    }

    return [...memories]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, count);
  }
}
