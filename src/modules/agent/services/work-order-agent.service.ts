import { Injectable } from '@nestjs/common';
import {
  WorkOrderAgentHelper,
  type WorkOrderAgentConfig,
  type WorkOrderAgentState,
  type WorkOrder,
  type ResearchResult,
  type EconomicConfig,
  type WorkOrderEvaluation,
} from '../work-order-agent';
import { LangGraphWorkOrderAgentService } from './langgraph-work-order-agent.service';
import { isLangGraphMode } from '../../config/config';
import type { AgentBrain } from '../agent-brain';
import type { LLMModel, LLMConfig } from '../../llm/llm-provider';

@Injectable()
export class WorkOrderAgentService {
  constructor(
    private readonly workOrderAgentHelper: WorkOrderAgentHelper,
    private readonly langGraphService: LangGraphWorkOrderAgentService,
  ) {}

  start(config: WorkOrderAgentConfig): Promise<void> {
    if (isLangGraphMode()) {
      return this.langGraphService.start(config);
    }
    return this.workOrderAgentHelper.startWorkOrderAgent(config);
  }

  stop(): void {
    if (isLangGraphMode()) {
      this.langGraphService.stop();
      return;
    }
    return this.workOrderAgentHelper.stopWorkOrderAgent();
  }

  getState(): WorkOrderAgentState {
    return this.workOrderAgentHelper.getWorkOrderAgentState();
  }

  resetState(): void {
    return this.workOrderAgentHelper.resetWorkOrderAgentState();
  }

  runIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
    return this.workOrderAgentHelper.runWorkOrderAgentIteration(config, iteration, brain);
  }

  fetchAvailable(
    coordinatorUrl: string,
    peerId: string,
    capabilities: string[],
  ): Promise<WorkOrder[]> {
    return this.workOrderAgentHelper.fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
  }

  accept(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    nodeCapabilities?: string[],
  ): Promise<boolean> {
    return this.workOrderAgentHelper.acceptWorkOrder(coordinatorUrl, workOrderId, peerId, nodeCapabilities);
  }

  complete(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: string,
    success?: boolean,
  ): Promise<boolean> {
    return this.workOrderAgentHelper.completeWorkOrder(coordinatorUrl, workOrderId, peerId, result, success);
  }

  execute(
    workOrder: WorkOrder,
    llmModel: LLMModel,
    llmConfig?: LLMConfig,
  ): Promise<{ result: string; success: boolean }> {
    return this.workOrderAgentHelper.executeWorkOrder(workOrder, llmModel, llmConfig);
  }

  executeResearch(
    workOrder: WorkOrder,
    llmModel: LLMModel,
    llmConfig?: LLMConfig,
  ): Promise<{ result: ResearchResult; rawResponse: string; success: boolean }> {
    return this.workOrderAgentHelper.executeResearchWorkOrder(workOrder, llmModel, llmConfig);
  }

  isResearch(workOrder: WorkOrder): boolean {
    return this.workOrderAgentHelper.isResearchWorkOrder(workOrder);
  }

  extractResearchPayload(workOrder: WorkOrder) {
    return this.workOrderAgentHelper.extractResearchPayload(workOrder);
  }

  buildResearchPrompt(payload: { title: string; abstract: string }): string {
    return this.workOrderAgentHelper.buildResearchPrompt(payload);
  }

  evaluate(workOrder: WorkOrder, config: EconomicConfig): WorkOrderEvaluation {
    return this.workOrderAgentHelper.evaluateWorkOrder(workOrder, config);
  }

  loadEconomicConfig(runtimeModel?: string): EconomicConfig {
    return this.workOrderAgentHelper.loadEconomicConfig(runtimeModel);
  }

  estimateLLMCost(abstract: string, config: EconomicConfig): number {
    return this.workOrderAgentHelper.estimateLLMCost(abstract, config);
  }

  getModelCostPer1kTokens(model: string): number {
    return this.workOrderAgentHelper.getModelCostPer1kTokens(model);
  }

  shouldContinueLoop(isRunning: boolean, iteration: number, maxIterations?: number): boolean {
    return this.workOrderAgentHelper.shouldContinueLoop(isRunning, iteration, maxIterations);
  }

  shouldStop(iteration: number, maxIterations?: number): boolean {
    return this.workOrderAgentHelper.shouldStopForMaxIterations(iteration, maxIterations);
  }

  shouldSleep(isRunning: boolean): boolean {
    return this.workOrderAgentHelper.shouldSleepBetweenIterations(isRunning);
  }

  submitResearchResult(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: ResearchResult,
  ): Promise<boolean> {
    return this.workOrderAgentHelper.submitResearchResult(coordinatorUrl, workOrderId, peerId, result);
  }
}
