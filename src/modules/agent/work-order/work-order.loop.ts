/**
 * WorkOrderLoopHelper — the main agent loop: start/stop/iterate.
 * Orchestrates state, coordinator, execution, and peer services.
 */

import { Injectable } from '@nestjs/common';
import logger from '../../../utils/logger';
import type { AgentBrain } from '../agent-brain';
import { AgentBrainHelper } from '../agent-brain';
import { RoundListenerHelper } from '../round-listener';
import { WorkOrderStateHelper } from './work-order.state';
import { WorkOrderCoordinatorHelper } from './work-order.coordinator';
import { WorkOrderExecutionHelper } from './work-order.execution';
import { WorkOrderEvaluationHelper } from './work-order.evaluation';
import { BackpressureService } from './backpressure.service';
import type { WorkOrderAgentConfig, WorkOrder, WorkOrderAgentState, ResearchResult } from './work-order.types';
import { resolveTrainingChain } from '../../llm/training-llm';
import type { LLMModel } from '../../llm/llm-provider';

@Injectable()
export class WorkOrderLoopHelper {
  constructor(
    private readonly state: WorkOrderStateHelper,
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly execution: WorkOrderExecutionHelper,
    private readonly evaluation: WorkOrderEvaluationHelper,
    private readonly roundListener: RoundListenerHelper,
    private readonly agentBrain: AgentBrainHelper,
    private readonly backpressure: BackpressureService,
  ) {}

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

    this.roundListener.startRoundListener(config.coordinatorUrl, peerId, {
      llmModel: config.llmModel,
      llmConfig: config.llmConfig,
    });

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
    const { coordinatorUrl, peerId, capabilities, llmModel, llmConfig } = config;

    logger.log(`..............................`);
    logger.log(`Iteration ${iteration} starting...`);
    logger.log(' Polling for available work orders...');

    const workOrders = await this.coordinator.fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
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

    for (const workOrder of orderedByType) {
      logger.log(` Selected: "${workOrder.title}" (reward: ${workOrder.rewardAmount} SYN)`);

      // Backpressure check: reject if at capacity
      if (!this.backpressure.canAccept()) {
        logger.warn(
          `[Backpressure] At capacity (${this.backpressure.getInFlight()}/${this.backpressure.getMaxConcurrent()}) — skipping remaining WOs`,
        );
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

      const accepted = await this.coordinator.acceptWorkOrder(coordinatorUrl, workOrder.id, peerId, capabilities);
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
          coordinatorUrl, workOrder.id, peerId, result, success,
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
        return { workOrder, completed, researchResult };
      } finally {
        this.backpressure.release(workOrder.id);
      }
    }

    logger.log(' Could not accept any work order (all failed or skipped)');
    this.state.iteration = iteration;
    return { completed: false };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
