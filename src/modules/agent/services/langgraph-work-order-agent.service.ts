import { Injectable } from '@nestjs/common';
import { AgentGraphService } from '../langgraph/agent-graph.service';
import { AgentBrainHelper } from '../agent-brain';
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
  private brain: AgentBrain;

  constructor(
    private readonly agentGraphService: AgentGraphService,
    private readonly agentBrainHelper: AgentBrainHelper,
  ) {
    this.brain = this.agentBrainHelper.initBrain();
  }

  start(config: WorkOrderAgentConfig): Promise<void> {
    if (this.isRunning) throw new Error('LangGraph agent is already running');
    this.isRunning = true;
    const { intervalMs, maxIterations } = config;
    logger.log('🚀 Starting LangGraph work order agent');
    logger.log(`   Coordinator: ${config.coordinatorUrl}`);
    logger.log(`   Mode: langgraph`);
    return this.runLoop(config, intervalMs ?? 30_000, maxIterations);
  }

  stop(): void {
    this.isRunning = false;
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

  async runIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
    const result = await this.agentGraphService.runIteration(config, iteration, brain ?? this.brain);

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
      try {
        await this.runIteration(config, iteration);
      } catch (error) {
        logger.error(` Iteration ${iteration} failed:`, (error as Error).message);
      }
      if (this.shouldContinue(iteration + 1, maxIterations)) {
        await this.sleep(intervalMs);
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
