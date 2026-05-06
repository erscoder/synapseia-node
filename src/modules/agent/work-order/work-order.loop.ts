/**
 * WorkOrderLoopHelper — the main agent loop: start/stop/iterate.
 * Orchestrates state, coordinator, execution, and peer services.
 */

import { Injectable, Optional } from '@nestjs/common';
import logger from '../../../utils/logger';
import type { AgentBrain } from '../agent-brain';
import { AgentBrainHelper } from '../agent-brain';
import { RoundListenerHelper } from '../round-listener';
import { WorkOrderStateHelper } from './work-order.state';
import { WorkOrderCoordinatorHelper } from './work-order.coordinator';
import { WorkOrderExecutionHelper } from './work-order.execution';
import { WorkOrderEvaluationHelper } from './work-order.evaluation';
import { BackpressureService } from './backpressure.service';
import { WorkOrderPushQueue, PushedWorkOrder } from './work-order-push-queue';
import type { WorkOrderAgentConfig, WorkOrder, WorkOrderAgentState, ResearchResult } from './work-order.types';
import { resolveTrainingChain } from '../../llm/training-llm';
import type { LLMModel } from '../../llm/llm-provider';

@Injectable()
export class WorkOrderLoopHelper {
  /**
   * Resolved when the current sleep should be interrupted (e.g. push queue
   * received a fresh WO from gossipsub). Cleared after every wake-up so
   * subsequent sleeps install fresh resolvers.
   */
  private wakeUpResolve: (() => void) | null = null;

  constructor(
    private readonly state: WorkOrderStateHelper,
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly execution: WorkOrderExecutionHelper,
    private readonly evaluation: WorkOrderEvaluationHelper,
    private readonly roundListener: RoundListenerHelper,
    private readonly agentBrain: AgentBrainHelper,
    private readonly backpressure: BackpressureService,
    @Optional() private readonly pushQueue?: WorkOrderPushQueue,
  ) {
    // If the queue was injected, register our wake hook so push messages
    // can interrupt the long fallback sleep (5 min by default).
    this.pushQueue?.setWakeCallback(() => this.interruptSleep());
  }

  /** Interrupts an in-flight `sleep()` so the loop can react to a push. */
  interruptSleep(): void {
    const resolve = this.wakeUpResolve;
    if (resolve) {
      this.wakeUpResolve = null;
      resolve();
    }
  }

  getWorkOrderAgentState(): WorkOrderAgentState {
    return this.state.getState();
  }

  resetWorkOrderAgentState(): void {
    this.state.resetState();
  }

  stopWorkOrderAgent(): void {
    this.state.isRunning = false;
    logger.log(' Stopping...');
  }

  shouldContinueLoop(isRunning: boolean, iteration: number, maxIterations?: number): boolean {
    return this.state.shouldContinueLoop(isRunning, iteration, maxIterations);
  }

  shouldStopForMaxIterations(iteration: number, maxIterations?: number): boolean {
    return this.state.shouldStopForMaxIterations(iteration, maxIterations);
  }

  shouldSleepBetweenIterations(isRunning: boolean): boolean {
    return this.state.shouldSleepBetweenIterations(isRunning);
  }


  async startWorkOrderAgent(config: WorkOrderAgentConfig): Promise<void> {
    if (this.state.isRunning) throw new Error('Work order agent is already running');

    this.state.isRunning = true;
    const { intervalMs, maxIterations } = config;
    const peerId = config.peerId ?? 'unknown';

    this.roundListener.startRoundListener(
      config.coordinatorUrl,
      peerId,
      {
        llmModel: config.llmModel,
        llmConfig: config.llmConfig,
      },
      config.coordinatorWsUrl,
    );

    try {
      let iteration = 1;
      /* istanbul ignore next - async loop control, not business logic */
      while (this.state.shouldContinueLoop(this.state.isRunning, iteration, maxIterations)) {
        try {
          await this.runWorkOrderAgentIteration(config, iteration);
        } catch (error) {
          logger.error(` Iteration ${iteration} failed:`, (error as Error).message);
        }

        if (this.state.shouldSleepBetweenIterations(this.state.isRunning)) {
          logger.log(` Sleeping for ${intervalMs}ms...`);
          /* istanbul ignore next - async loop control, not business logic */
          await this.sleep(intervalMs);
        }

        iteration++;
      }

      if (maxIterations && iteration > maxIterations) {
        logger.log(`\n Reached max iterations (${maxIterations}), stopping.`);
      }
    } finally {
      this.state.isRunning = false;
      logger.log('\n Stopped');
    }
  }

  async runWorkOrderAgentIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
    const { coordinatorUrl, peerId, walletAddress, capabilities, llmModel, llmConfig } = config;

    logger.log(`..............................`);
    logger.log(`Iteration ${iteration} starting...`);

    // Phase 2A: prefer the local push queue (fed by gossipsub
    // WORK_ORDER_AVAILABLE). Falls back to GET /work-orders/available only
    // when the queue is empty — which keeps the network noise-floor near
    // zero on idle nodes.
    let workOrders: WorkOrder[] = [];
    // Original gossip payloads keyed by WO id so we can re-queue unprocessed
    // entries WITHOUT refreshing their `receivedAt` (HIGH-1: TTL refresh
    // starvation — see WorkOrderPushQueue.requeue() rationale).
    const pushedById = new Map<string, PushedWorkOrder>();
    const pushed = this.pushQueue?.drain() ?? [];
    if (pushed.length > 0) {
      logger.log(` ${pushed.length} pushed work order(s) drained from gossip queue`);
      for (const entry of pushed) pushedById.set(entry.id, entry);
      const mapped = pushed.map(toWorkOrder);
      // Surface capability-filtered drops explicitly. Silent discard hid the
      // gossip-queue accumulation bug (CPU_INFERENCE WOs piling up while
      // GPU_INFERENCE drained) — see reviewer-lessons P22.
      for (const wo of mapped) {
        if (!this.matchesCapability(wo, capabilities)) {
          const required = wo.requiredCapabilities ?? [];
          logger.warn(
            `dropped WO ${wo.id} from push queue: required [${required.join(',')}] not in node caps [${capabilities.join(',')}]`,
          );
        }
      }
      workOrders = mapped.filter((wo) => this.matchesCapability(wo, capabilities));
    }
    if (workOrders.length === 0) {
      logger.log(' Polling /work-orders/available (push queue empty)...');
      workOrders = await this.coordinator.fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
    }
    if (workOrders.length === 0) { logger.log(' No work orders available'); return { completed: false }; }

    logger.log(` Found ${workOrders.length} available work order(s)`);

    const now = Date.now();
    const pendingWorkOrders = workOrders.filter(wo => {
      if (this.execution.isResearchWorkOrder(wo)) {
        if (this.state.isOnCooldown(wo.id)) {
          logger.log(` Research WO "${wo.title}" on cooldown — ${this.state.getCooldownRemainingSec(wo.id)}s remaining`);
          return false;
        }
        return true;
      }
      return !this.state.isCompleted(wo.id);
    });

    if (pendingWorkOrders.length < workOrders.length) {
      logger.log(` Skipping ${workOrders.length - pendingWorkOrders.length} WO(s) (completed/cooldown) — ${pendingWorkOrders.length} remaining`);
    }
    if (pendingWorkOrders.length === 0) { logger.log(' All work orders completed or on cooldown — waiting'); return { completed: false }; }

    // Round-robin type selection: prefer the type executed least often this session
    // so all WO types (RESEARCH, TRAINING, CPU_INFERENCE, etc.) get fair turns
    const orderedByType = this.selectByTypeRotation(pendingWorkOrders);
    logger.log(` Type rotation: selected [${orderedByType.map(w => w.type).join(', ')}]`);

    // Tracks the index of the item being processed in this iteration. Items
    // at indices >= unprocessedStart when we exit are NOT YET attempted
    // and must be re-queued so the next iteration can pick them up. Items
    // at indices < unprocessedStart were already evaluated (accepted,
    // skipped on economics, accept-failed, etc.) and must NOT be re-queued.
    //
    // - Natural for-loop exit: attemptedIndex === orderedByType.length, no
    //   re-queue needed (nothing left).
    // - `break` on capacity hit: attemptedIndex points at the item we did
    //   NOT attempt → re-queue starts at attemptedIndex (inclusive).
    // - `return` after successful accept: attemptedIndex points at the
    //   accepted item → re-queue starts at attemptedIndex + 1.
    let attemptedIndex = 0;
    let unprocessedStart = orderedByType.length; // default: nothing to re-queue
    try {
      for (attemptedIndex = 0; attemptedIndex < orderedByType.length; attemptedIndex++) {
        const workOrder = orderedByType[attemptedIndex];
        logger.log(` Selected: "${workOrder.title}" (reward: ${workOrder.rewardAmount} SYN)`);

        // Backpressure check: reject if at capacity. Expected behaviour, info
        // level — see fetch-work-orders.ts for the polling counterpart.
        if (!this.backpressure.canAccept()) {
          logger.info(
            `[Backpressure] At capacity (${this.backpressure.getInFlight()}/${this.backpressure.getMaxConcurrent()}) — skipping remaining WOs`,
          );
          // Capacity hit: this WO has NOT been attempted yet, re-queue it
          // alongside the remaining items.
          unprocessedStart = attemptedIndex;
          break;
        }

        // Economic evaluation
        const fullModelId = config.llmModel
          ? config.llmModel.provider === 'ollama'
            ? `ollama/${config.llmModel.modelId}`
            : config.llmModel.providerId
              ? `${config.llmModel.providerId}/${config.llmModel.modelId}`
              : config.llmModel.modelId
          : undefined;
        const economicConfig = this.evaluation.loadEconomicConfig(fullModelId);
        const ev = this.evaluation.evaluateWorkOrder(workOrder, economicConfig);

        logger.log(` Economic evaluation:`);
        logger.log(`  - Bounty: ${ev.bountyUsd.toFixed(4)} USD (${workOrder.rewardAmount} SYN)`);
        logger.log(`  - Est. cost: ${ev.estimatedCostUsd.toFixed(4)} USD`);
        logger.log(`  - Profit ratio: ${ev.profitRatio === Infinity ? '∞' : ev.profitRatio.toFixed(2) + 'x'}`);
        logger.log(`  - Decision: ${ev.shouldAccept ? 'ACCEPT' : 'SKIP'} (${ev.reason})`);

        if (!ev.shouldAccept) { logger.log(' Skipping work order due to poor economics'); continue; }

        logger.log(' Accepting work order...');

        // Acquire backpressure slot before accepting
        if (!this.backpressure.acquire(workOrder.id)) {
          logger.warn(`[Backpressure] Cannot acquire slot for WO ${workOrder.id} — skipping`);
          continue;
        }

        const accepted = await this.coordinator.acceptWorkOrder(coordinatorUrl, workOrder.id, peerId, walletAddress, capabilities);
        if (!accepted) {
          this.backpressure.release(workOrder.id);
          logger.log(' Failed to accept work order (likely race condition), trying next...');
          continue;
        }

        try {
          logger.log(' Work order accepted');
          this.state.currentWorkOrder = workOrder;
          // Track type for round-robin rotation
          const woType = workOrder.type ?? 'COMPUTATION';
          this.state.lastAcceptedType = woType;
          this.state.typeExecutionCount.set(
            woType,
            (this.state.typeExecutionCount.get(woType) ?? 0) + 1,
          );

          // Execute
          logger.log(' Executing work order...');
          let result: string;
          let success: boolean;
          let researchResult: ResearchResult | undefined;

          if (this.execution.isDockingWorkOrder(workOrder)) {
            const docking = await this.execution.executeDockingWorkOrder(workOrder, peerId);
            result = docking.result; success = docking.success;
          } else if (this.execution.isLoraWorkOrder(workOrder)) {
            const lora = await this.execution.executeLoraWorkOrder(workOrder, peerId);
            result = lora.result; success = lora.success;
          } else if (this.execution.isGpuInferenceWorkOrder(workOrder)) {
            try {
              const inferenceResult = await this.execution.executeGpuInferenceWorkOrder(workOrder, llmModel, llmConfig);
              result = JSON.stringify({ ...inferenceResult, metricType: 'latency', metricValue: inferenceResult.latencyMs });
              success = true;
            } catch (err) { result = `GPU inference failed: ${(err as Error).message}`; success = false; }
          } else if (this.execution.isCpuInferenceWorkOrder(workOrder)) {
            try {
              const inferenceResult = await this.execution.executeCpuInferenceWorkOrder(workOrder, llmModel, llmConfig, coordinatorUrl);
              result = JSON.stringify({ ...inferenceResult, metricType: 'latency', metricValue: inferenceResult.latencyMs });
              success = true;
            } catch (err) { result = `CPU inference failed: ${(err as Error).message}`; success = false; }
          } else if (this.execution.isDiLoCoWorkOrder(workOrder)) {
            const diloco = await this.execution.executeDiLoCoWorkOrder(workOrder, coordinatorUrl, peerId, capabilities);
            result = diloco.result; success = diloco.success;
          } else if (this.execution.isTrainingWorkOrder(workOrder)) {
            // Resolve primary + full fallback chain (Ollama capable → cloud →
            // Ollama small). Any model's JSON glitch is absorbed by the next
            // candidate. See resolveTrainingChain() for the rationale.
            const chain = await resolveTrainingChain();
            if (!chain) {
              logger.warn(' No training LLM available — skipping training WO');
              result = 'No training LLM available';
              success = false;
            } else {
              const training = await this.execution.executeTrainingWorkOrder(
                workOrder, coordinatorUrl, peerId, capabilities, iteration,
                chain.primary, llmConfig, chain.fallbacks,
              );
              result = training.result; success = training.success;
            }
          } else if (this.execution.isResearchWorkOrder(workOrder)) {
            const research = await this.execution.executeResearchWorkOrder(workOrder, llmModel, llmConfig, coordinatorUrl, peerId);
            // Do NOT send `proof` — the coordinator computes a stable artefact
            // reference (`submission:<id>`) when the node lacks a real hash.
            // Sending the proposal text as `proof` was the bug that polluted the
            // DB with placeholders like "See summary for details".
            result = JSON.stringify({
              summary: research.result.summary,
              keyInsights: research.result.keyInsights,
              proposal: research.result.proposal,
              hypothesis: research.result.summary,
              metricType: 'coherence',
              metricValue: research.success ? this.evaluation.scoreResearchResult(research.result) : 0.0,
            });
            success = research.success;
            researchResult = research.result;
            const researchHyperparams = research.hyperparams;

            if (brain && success) {
              this.execution.saveResearchToBrain(brain, workOrder, researchResult);
              this.agentBrain.saveBrainToDisk(brain);
              logger.log(' Research saved to agent brain');
            }

            // NOTE: Research result is submitted via completeWorkOrder() below.
            // The coordinator extracts summary/insights/proposal from the result JSON
            // and registers a Submission in the active ResearchRound automatically.
            // (Legacy /papers/results endpoint removed — it no longer exists on coordinator.)
            void researchHyperparams; // silence unused warning — hyperparams tracked via reportHyperparamExperiment
          } else {
            const execution = await this.execution.executeWorkOrder(workOrder, llmModel, llmConfig);
            result = execution.result; success = execution.success;
          }

          // Quality gates
          if ((this.execution.isResearchWorkOrder(workOrder) || this.execution.isTrainingWorkOrder(workOrder) || this.execution.isDiLoCoWorkOrder(workOrder) || this.execution.isCpuInferenceWorkOrder(workOrder) || this.execution.isGpuInferenceWorkOrder(workOrder) || this.execution.isDockingWorkOrder(workOrder) || this.execution.isLoraWorkOrder(workOrder)) && !success) {
            logger.warn(' Work order execution failed — skipping result submission');
            this.state.currentWorkOrder = undefined;
            continue;
          }

          if (this.execution.isResearchWorkOrder(workOrder) && researchResult) {
            const submissionScore = this.evaluation.scoreResearchResult(researchResult);
            if (submissionScore < this.state.submissionMinScoreThreshold) {
              logger.warn(` Research score ${submissionScore.toFixed(4)} < threshold ${this.state.submissionMinScoreThreshold} — skipping submission`);
              this.state.currentWorkOrder = undefined;
              continue;
            }
          }

          // Rate limit
          await this.state.checkRateLimit();

          logger.log(' Reporting result...');
          const completed = await this.coordinator.completeWorkOrder(
            coordinatorUrl, workOrder.id, peerId, walletAddress, result, success,
            new Set(this.state.getState().completedWorkOrderIds),
            (id) => this.state.markCompleted(id),
            (lamports) => this.state.addRewards(lamports),
            (s) => this.state.parseSynToLamports(s),
          );

          if (completed) {
            logger.log(` Result submitted for round evaluation! Potential reward: ${workOrder.rewardAmount} SYN (paid when round closes)`);
            this.state.incrementCompleted();
            if (this.execution.isResearchWorkOrder(workOrder)) {
              this.state.setCooldown(workOrder.id);
            } else if (this.execution.isCpuInferenceWorkOrder(workOrder)) {
              logger.log(` CPU inference result submitted — reward: ${workOrder.rewardAmount} SYN`);
            }
          } else {
            logger.log(' Failed to report completion');
          }

          this.state.iteration = iteration;
          // Successful accept: items AFTER the current one were not yet
          // attempted. Re-queue starts at attemptedIndex + 1.
          unprocessedStart = attemptedIndex + 1;
          return { workOrder, completed, researchResult };
        } finally {
          this.backpressure.release(workOrder.id);
        }
      }
    } finally {
      // Re-queue items that were drained but NOT yet attempted (capacity
      // hit before reaching them, or we returned after accepting one). Past
      // attempts (skipped on economics, accept-failed, exec-failed) are
      // intentionally NOT re-queued — they would loop forever.
      //
      // HIGH-1: use `requeue()`, NOT `push()`. Push would stamp a fresh
      // `receivedAt` and let a WO that loses the capacity race repeatedly
      // live forever (TTL refresh starvation). `requeue()` writes back the
      // ORIGINAL `PushedWorkOrder` so the 60s safety net is honoured.
      // We look up the original payload via `pushedById`; entries fetched
      // from the HTTP fallback (not the gossip queue) have no original
      // payload and are simply dropped — they'll be re-fetched on the next
      // poll anyway.
      if (unprocessedStart < orderedByType.length && this.pushQueue) {
        const unprocessed = orderedByType.slice(unprocessedStart);
        let requeuedCount = 0;
        for (const wo of unprocessed) {
          const original = pushedById.get(wo.id);
          if (!original) continue; // HTTP-fallback WO; nothing to requeue
          this.pushQueue.requeue(original);
          requeuedCount++;
        }
        if (requeuedCount > 0) {
          logger.log(
            ` re-queued ${requeuedCount} work order(s) for next iteration (capacity hit or accept committed)`,
          );
        }
      }
    }

    logger.log(' Could not accept any work order (all failed or skipped)');
    this.state.iteration = iteration;
    return { completed: false };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUpResolve = null;
        resolve();
      }, ms);
      // Replace any stale resolver — only the latest sleep is interruptible.
      this.wakeUpResolve = () => {
        clearTimeout(timer);
        this.wakeUpResolve = null;
        resolve();
      };
    });
  }

  /**
   * Cheap capability check on pushed work orders. Mirrors the server-side
   * filter that GET /work-orders/available applies — required-capability
   * match, with empty `requiredCapabilities` treated as universally
   * eligible. Strict equality is intentional: the loop's downstream logic
   * (selection, execution) already handles per-type routing.
   */
  private matchesCapability(wo: WorkOrder, capabilities: string[]): boolean {
    const required = wo.requiredCapabilities ?? [];
    if (required.length === 0) return true;
    return required.every((c) => capabilities.includes(c));
  }

  /**
   * Sort work orders so the type executed least often this session comes first.
   * Ensures fair round-robin across RESEARCH / TRAINING / CPU_INFERENCE / etc.
   * Within the same type, preserve original order (highest reward first from coordinator).
   */
  private selectByTypeRotation(workOrders: WorkOrder[]): WorkOrder[] {
    const countForType = (type: string) => this.state.typeExecutionCount.get(type) ?? 0;

    // Group by type, preserving intra-group order
    const groups = new Map<string, WorkOrder[]>();
    for (const wo of workOrders) {
      const key = wo.type ?? 'UNKNOWN';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(wo);
    }

    // Sort type groups by execution count ascending (least executed first)
    const sortedTypes = [...groups.keys()].sort(
      (a, b) => countForType(a) - countForType(b),
    );

    // Flatten: one WO per type, then next WO per type, etc.
    const result: WorkOrder[] = [];
    let idx = 0;
    while (result.length < workOrders.length) {
      let added = false;
      for (const type of sortedTypes) {
        const group = groups.get(type)!;
        if (idx < group.length) {
          result.push(group[idx]);
          added = true;
        }
      }
      if (!added) break;
      idx++;
    }
    return result;
  }
}

/**
 * Strip `receivedAt` and surface the gossip payload as a `WorkOrder` so
 * downstream loop code (which already accepts the HTTP `/work-orders/
 * available` response shape) can consume push messages identically. The
 * coordinator's `toResponseDto` keeps both shapes in lockstep — the cast
 * is safe by construction.
 */
function toWorkOrder(pushed: PushedWorkOrder): WorkOrder {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { receivedAt: _ignored, ...rest } = pushed;
  return rest as unknown as WorkOrder;
}
