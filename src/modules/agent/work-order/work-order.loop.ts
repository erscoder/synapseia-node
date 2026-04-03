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
import type { WorkOrderAgentConfig, WorkOrder, WorkOrderAgentState, ResearchResult } from './work-order.types';

@Injectable()
export class WorkOrderLoopHelper {
  constructor(
    private readonly state: WorkOrderStateHelper,
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly execution: WorkOrderExecutionHelper,
    private readonly evaluation: WorkOrderEvaluationHelper,
    private readonly roundListener: RoundListenerHelper,
    private readonly agentBrain: AgentBrainHelper,
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

    for (const workOrder of pendingWorkOrders) {
      logger.log(` Selected: "${workOrder.title}" (reward: ${workOrder.rewardAmount} SYN)`);

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
      const accepted = await this.coordinator.acceptWorkOrder(coordinatorUrl, workOrder.id, peerId, capabilities);
      if (!accepted) { logger.log(' Failed to accept work order (likely race condition), trying next...'); continue; }

      logger.log(' Work order accepted');
      this.state.currentWorkOrder = workOrder;

      // Execute
      logger.log(' Executing work order...');
      let result: string;
      let success: boolean;
      let researchResult: ResearchResult | undefined;

      if (this.execution.isCpuInferenceWorkOrder(workOrder)) {
        try {
          const inferenceResult = await this.execution.executeCpuInferenceWorkOrder(workOrder, llmModel, llmConfig, coordinatorUrl);
          result = JSON.stringify({ ...inferenceResult, metricType: 'latency', metricValue: inferenceResult.latencyMs });
          success = true;
        } catch (err) { result = `CPU inference failed: ${(err as Error).message}`; success = false; }
      } else if (this.execution.isDiLoCoWorkOrder(workOrder)) {
        const diloco = await this.execution.executeDiLoCoWorkOrder(workOrder, coordinatorUrl, peerId, capabilities);
        result = diloco.result; success = diloco.success;
      } else if (this.execution.isTrainingWorkOrder(workOrder)) {
        const training = await this.execution.executeTrainingWorkOrder(workOrder, coordinatorUrl, peerId, capabilities, iteration);
        result = training.result; success = training.success;
      } else if (this.execution.isResearchWorkOrder(workOrder)) {
        const research = await this.execution.executeResearchWorkOrder(workOrder, llmModel, llmConfig, coordinatorUrl, peerId);
        result = JSON.stringify({ summary: research.result.summary, keyInsights: research.result.keyInsights, proposal: research.result.proposal, hypothesis: research.result.summary, metricType: 'coherence', metricValue: research.success ? this.evaluation.scoreResearchResult(research.result) : 0.0, proof: research.result.proposal });
        success = research.success;
        researchResult = research.result;
        const researchHyperparams = research.hyperparams;

        if (brain && success) {
          this.execution.saveResearchToBrain(brain, workOrder, researchResult);
          this.agentBrain.saveBrainToDisk(brain);
          logger.log(' Research saved to agent brain');
        }

        if (success) {
          let paperId = workOrder.id.replace(/^wo_/, 'paper_');
          try {
            const resp = await fetch(`${coordinatorUrl}/research-queue/papers`);
            if (resp.ok) {
              const data = await resp.json() as { papers?: Array<{ id: string; title: string }> };
              const match = data.papers?.find(p => p.title === workOrder.title || p.title.includes(workOrder.title.substring(0, 40)));
              if (match) paperId = match.id;
            }
          } catch (e) { logger.warn(' Failed to lookup paperId:', e); }

          const submitted = await this.coordinator.submitResearchResult(coordinatorUrl, paperId, peerId, researchResult, researchHyperparams);
          if (submitted) logger.log(' Research result submitted to research queue');
        }
      } else {
        const execution = await this.execution.executeWorkOrder(workOrder, llmModel, llmConfig);
        result = execution.result; success = execution.success;
      }

      // Quality gates
      if ((this.execution.isResearchWorkOrder(workOrder) || this.execution.isTrainingWorkOrder(workOrder) || this.execution.isDiLoCoWorkOrder(workOrder) || this.execution.isCpuInferenceWorkOrder(workOrder)) && !success) {
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
    }

    logger.log(' Could not accept any work order (all failed or skipped)');
    this.state.iteration = iteration;
    return { completed: false };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
