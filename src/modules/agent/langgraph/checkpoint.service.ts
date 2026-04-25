/**
 * Checkpoint Service - LangGraph state persistence
 *
 * Uses MemorySaver (in-memory checkpointer) for within-session crash recovery.
 *
 * WHY NOT SQLite:
 * `@langchain/langgraph-checkpoint-sqlite` depends on `better-sqlite3` which
 * requires native compilation. The Synapseia node ships as an ESM bundle via
 * tsup and must run on arbitrary machines without a build toolchain. Adding a
 * native dependency would break `npx @synapseia/node` installs and complicate
 * the Tauri desktop build. MemorySaver still gives us within-process recovery
 * (e.g. a transient LLM timeout mid-graph won't lose prior node outputs).
 * True cross-restart persistence will be added when we move to the Tauri
 * embedded SQLite that the desktop app already ships.
 */

import { Injectable } from '@nestjs/common';
import { MemorySaver } from '@langchain/langgraph';
import logger from '../../../utils/logger';

@Injectable()
export class CheckpointService {
  private readonly checkpointer: MemorySaver;
  private readonly activeThreads = new Map<string, { startedAt: number; workOrderId: string }>();

  constructor() {
    this.checkpointer = new MemorySaver();
    logger.log('[Checkpoint] Initialized MemorySaver (in-memory checkpointer)');
  }

  /** Returns the shared checkpointer instance for graph compilation. */
  getCheckpointer(): MemorySaver {
    return this.checkpointer;
  }

  /**
   * Derive a deterministic thread_id from a work order ID.
   * Format: `wo_<workOrderId>` so threads are 1:1 with work orders.
   */
  threadIdForWorkOrder(workOrderId: string): string {
    return `wo_${workOrderId}`;
  }

  /** Track that a thread is actively executing. */
  registerThread(threadId: string, workOrderId: string): void {
    this.activeThreads.set(threadId, {
      startedAt: Date.now(),
      workOrderId,
    });
  }

  /** Mark a thread as completed (remove from active tracking). */
  completeThread(threadId: string): void {
    this.activeThreads.delete(threadId);
  }

  /**
   * Log any threads that were still active (incomplete) at startup.
   * Called once during module initialization to detect crash leftovers.
   * Does NOT auto-resume -- the coordinator re-assigns stale work orders.
   */
  logIncompleteThreads(): void {
    if (this.activeThreads.size === 0) {
      logger.log('[Checkpoint] No incomplete threads found');
      return;
    }

    for (const [threadId, meta] of this.activeThreads) {
      const age = Date.now() - meta.startedAt;
      logger.warn(
        `[Checkpoint] Incomplete thread detected: ${threadId} ` +
          `(workOrder=${meta.workOrderId}, age=${Math.round(age / 1000)}s). ` +
          `Coordinator will re-assign if stale.`,
      );
    }
  }

  /** Returns the count of currently active threads. */
  getActiveThreadCount(): number {
    return this.activeThreads.size;
  }

  /** Returns all active thread IDs (for diagnostics). */
  getActiveThreadIds(): string[] {
    return Array.from(this.activeThreads.keys());
  }
}
