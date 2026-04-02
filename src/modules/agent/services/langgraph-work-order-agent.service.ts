/**
 * LangGraph Work Order Agent Service
 * Sprint A - LangGraph Foundation
 * 
 * Implements the same interface as WorkOrderAgentService but uses LangGraph
 */

import { Injectable } from '@nestjs/common';
import type { AgentBrain } from '../agent-brain.js';
import type { WorkOrder, ResearchResult, WorkOrderAgentConfig } from '../work-order-agent.js';
import { runLangGraphIteration } from '../langgraph/graph.js';
import { initBrain } from '../agent-brain.js';
import logger from '../../../utils/logger.js';

export interface WorkOrderAgentState {
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

  constructor() {
    this.brain = initBrain();
  }

  start(config: WorkOrderAgentConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('Work order agent is already running');
    }

    this.isRunning = true;
    const { intervalMs, maxIterations } = config;

    logger.log('🚀 Starting LangGraph work order agent...');
    logger.log(`   Agent mode: langgraph`);
    logger.log(`   Coordinator: ${config.coordinatorUrl}`);

    return this.runLoop(config, intervalMs ?? 30000, maxIterations);
  }

  stop(): void {
    this.isRunning = false;
    logger.log(' Stopping LangGraph work order agent...');
  }

  getState(): WorkOrderAgentState {
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
    this.brain = initBrain();
  }

  async runIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
    const useBrain = brain ?? this.brain;
    const result = await runLangGraphIteration(config, iteration, useBrain);

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
        const result = await this.runIteration(config, iteration);
        
        if (result.completed) {
          logger.log(` Iteration ${iteration} completed work order`);
        }
      } catch (error) {
        logger.error(` Iteration ${iteration} failed:`, (error as Error).message);
      }

      // Sleep between iterations
      if (this.shouldContinue(iteration + 1, maxIterations)) {
        await this.sleep(intervalMs);
      }

      iteration++;
    }

    this.isRunning = false;
    logger.log(`\n LangGraph agent stopped (max iterations: ${maxIterations ?? 'unlimited'})`);
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
