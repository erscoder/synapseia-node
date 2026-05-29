import { Injectable } from '@nestjs/common';
import { AgentGraphService } from '../langgraph/agent-graph.service';
import { AgentBrainHelper } from '../agent-brain';
import { RoundListenerHelper } from '../round-listener';
import type { AgentBrain } from '../agent-brain';
import type { WorkOrder, ResearchResult, WorkOrderAgentConfig } from '../work-order/work-order.types';
import logger from '../../../utils/logger';

export interface LangGraphAgentState {
  isRunning: boolean;
  currentWorkOrder: WorkOrder | null;
  iteration: number;
  totalWorkOrdersCompleted: number;
}

@Injectable()
export class LangGraphWorkOrderAgentService {
  private isRunning = false;
  private currentWorkOrder: WorkOrder | null = null;
  private iteration = 0;
  private totalWorkOrdersCompleted = 0;
  private brain: AgentBrain | null = null;

  /**
   * D-P2P Slice 0.6 (2026-05-28) — kickIteration() state machine.
   *
   *  - `iterating`     : true while inside runIteration(). A kick during
   *                      this window sets `shouldKickNext` so the upcoming
   *                      sleep is skipped and the next iter starts
   *                      immediately after the current one returns.
   *  - `shouldKickNext`: deferred-kick flag (debounced — N kicks during
   *                      one iter collapse into one skipped sleep).
   *  - `sleepResolver` : the in-flight sleep's resolve callback. When non-
   *                      null we're parked in `sleep()`. A kick calls it
   *                      to break out of the timer early; the runLoop
   *                      continues to the next iter without waiting the
   *                      full intervalMs.
   *  - `sleepTimer`    : the underlying setTimeout handle so we can
   *                      clearTimeout() and avoid a leaked handle keeping
   *                      the event loop alive past stop().
   *
   * JS is single-threaded so these flags need no locks, but `kickIteration`
   * must guard against firing in two unsafe windows: (a) before start()
   * was called → `isRunning === false` → ignore, and (b) after stop() was
   * called → also `isRunning === false` → ignore. The sleep break-out
   * path is idempotent: resolving a Promise twice is a no-op in V8.
   */
  private iterating = false;
  private shouldKickNext = false;
  private sleepResolver: (() => void) | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;

  private getBrain(): AgentBrain {
    if (!this.brain) {
      this.brain = this.agentBrainHelper.initBrain();
    }
    return this.brain;
  }

  constructor(
    private readonly agentGraphService: AgentGraphService,
    private readonly agentBrainHelper: AgentBrainHelper,
    private readonly roundListenerHelper: RoundListenerHelper,
  ) {}

  start(config: WorkOrderAgentConfig): Promise<void> {
    if (this.isRunning) throw new Error('LangGraph agent is already running');
    this.isRunning = true;
    const { intervalMs, maxIterations } = config;
    logger.log('🚀 Starting LangGraph work order agent');
    logger.log(`   Coordinator: ${config.coordinatorUrl}`);
    logger.log(`   Mode: langgraph`);
    // Forward llmConfig so RoundListener can start the peer review loop on
    // `round.evaluating`. Without this the listener printed a "No LLM config
    // provided — skipping peer review loop" warning and no node ever picked
    // up PENDING evaluation assignments, which in turn blocked the whole
    // discovery + KG pipeline.
    this.roundListenerHelper.startRoundListener(
      config.coordinatorUrl,
      config.peerId,
      {
        llmModel: config.llmModel,
        llmConfig: config.llmConfig,
      },
      config.coordinatorWsUrl,
    );
    return this.runLoop(config, intervalMs ?? 30_000, maxIterations);
  }

  stop(): void {
    this.isRunning = false;
    // If we're parked in sleep, break out so runLoop sees !shouldContinue
    // and exits cleanly instead of waiting the full intervalMs to notice.
    this.interruptSleep();
    // Cascade teardown of the RoundListener WS this service started in
    // start() — without this the Socket.IO client keeps retrying with
    // `reconnectionAttempts: Infinity`, keeping the event loop alive and
    // the coord WS connection open after the node is asked to shut down
    // (audit nodeLOW-incomplete-graceful-shutdown).
    try {
      // Optional-call guards old test doubles that stub only
      // startRoundListener; the production helper always defines it.
      this.roundListenerHelper.stopRoundListener?.();
    } catch (err) {
      logger.warn(
        `[LangGraph] RoundListener teardown threw during stop(): ${(err as Error).message}`,
      );
    }
    logger.log(' Stopping LangGraph agent...');
  }

  getState(): LangGraphAgentState {
    return {
      isRunning: this.isRunning,
      currentWorkOrder: this.currentWorkOrder,
      iteration: this.iteration,
      totalWorkOrdersCompleted: this.totalWorkOrdersCompleted,
    };
  }

  resetState(): void {
    this.isRunning = false;
    this.currentWorkOrder = null;
    this.iteration = 0;
    this.totalWorkOrdersCompleted = 0;
    this.brain = this.agentBrainHelper.initBrain();
  }

  /**
   * D-P2P Slice 0.6 (2026-05-28) — wake hook target for the gossipsub
   * push queue. Wired from `node-runtime.ts` via
   * `workOrderPushQueue.setWakeCallback(() => agent.kickIteration())`.
   *
   * Three operating windows (single-threaded JS so no locks needed):
   *
   *   1. Loop not running (`!isRunning`) — no-op. Either the agent
   *      hasn't started yet (push arrived during boot) or stop() was
   *      called. Returning silently is correct: any queued envelope is
   *      already in the push queue and the next start() (if any) will
   *      drain it on its first iteration.
   *
   *   2. Currently inside `runIteration()` (`iterating === true`) — set
   *      `shouldKickNext = true`. The current iteration finishes
   *      naturally, then `runLoop` sees the flag and SKIPS the sleep,
   *      jumping straight into the next iteration so the freshly-pushed
   *      WO is drained immediately. Debounced: 100 rapid kicks collapse
   *      into a single skipped sleep.
   *
   *   3. Currently parked in `sleep()` (`sleepResolver !== null`) —
   *      resolve the sleep promise NOW. The timer is cleared so we don't
   *      leak handles, the resolver fires `runLoop` continues without
   *      waiting the remaining intervalMs.
   *
   * Idempotent. Safe to call from a hot gossipsub handler.
   */
  kickIteration(): void {
    if (!this.isRunning) return;

    if (this.iterating) {
      // Defer: current iter completes, then sleep is skipped.
      this.shouldKickNext = true;
      return;
    }

    // We're in sleep() (or between iter/sleep — both windows are safe
    // to break-and-fast-path). Resolve the sleep promise. The runLoop's
    // next tick will run an iteration immediately.
    this.interruptSleep();
  }

  async runIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
    const result = await this.agentGraphService.runIteration(config, iteration, brain ?? this.getBrain());

    if (result.completed && result.workOrder) {
      this.totalWorkOrdersCompleted++;
      this.currentWorkOrder = null;
    }

    return {
      workOrder: result.workOrder ?? undefined,
      completed: result.completed,
    };
  }

  private async runLoop(config: WorkOrderAgentConfig, intervalMs: number, maxIterations?: number): Promise<void> {
    let iteration = 1;
    while (this.shouldContinue(iteration, maxIterations)) {
      this.iterating = true;
      try {
        await this.runIteration(config, iteration);
      } catch (error) {
        logger.error(` Iteration ${iteration} failed:`, (error as Error).message);
      }
      this.iterating = false;

      if (this.shouldContinue(iteration + 1, maxIterations)) {
        // D-P2P Slice 0.6 — if a gossipsub push arrived during this
        // iteration, skip the sleep so the next iter picks the new WO up
        // immediately. Reset the flag in the same step so subsequent
        // sleeps still wait the full intervalMs unless kicked again.
        if (this.shouldKickNext) {
          this.shouldKickNext = false;
          logger.log('[D-P2P] sleep skipped — gossipsub push received mid-iter');
        } else {
          await this.sleep(intervalMs);
        }
      }
      iteration++;
    }
    this.isRunning = false;
    logger.log(`\n LangGraph agent stopped`);
  }

  private shouldContinue(iteration: number, maxIterations?: number): boolean {
    if (!this.isRunning) return false;
    if (maxIterations && iteration > maxIterations) return false;
    return true;
  }

  /**
   * Interruptable sleep. Records the active resolver + timer so
   * `kickIteration()` and `stop()` can break out early. The fields are
   * cleared on every settle path (timer fires, kick fires, abort fires).
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // If a kick or stop fires BEFORE setTimeout even returns, the
      // resolver path still works because the assignment below sequences
      // before any subsequent kickIteration() call (single-threaded).
      this.sleepResolver = () => {
        if (this.sleepTimer) {
          clearTimeout(this.sleepTimer);
          this.sleepTimer = null;
        }
        this.sleepResolver = null;
        resolve();
      };
      this.sleepTimer = setTimeout(() => {
        // Natural timeout — clear refs and resolve. Guarded against the
        // race where kick fired a microsecond before this callback.
        if (this.sleepResolver) {
          const r = this.sleepResolver;
          this.sleepResolver = null;
          this.sleepTimer = null;
          r();
        }
      }, ms);
    });
  }

  /**
   * Internal helper used by `kickIteration()` and `stop()`. If we're
   * currently parked in `sleep()`, resolve its promise NOW and clear
   * the timer. Idempotent — calling it from a non-sleep window is a
   * no-op.
   */
  private interruptSleep(): void {
    if (this.sleepResolver) {
      const r = this.sleepResolver;
      this.sleepResolver = null;
      if (this.sleepTimer) {
        clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
      }
      r();
    }
  }
}
