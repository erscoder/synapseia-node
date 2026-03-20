import { Injectable } from '@nestjs/common';
import {
  startWorkOrderAgent,
  stopWorkOrderAgent,
  getWorkOrderAgentState,
  resetWorkOrderAgentState,
  runWorkOrderAgentIteration,
  fetchAvailableWorkOrders,
  acceptWorkOrder,
  completeWorkOrder,
  executeWorkOrder,
  executeResearchWorkOrder,
  submitResearchResult,
  isResearchWorkOrder,
  extractResearchPayload,
  buildResearchPrompt,
  evaluateWorkOrder,
  loadEconomicConfig,
  estimateLLMCost,
  getModelCostPer1kTokens,
  shouldContinueLoop,
  shouldStopForMaxIterations,
  shouldSleepBetweenIterations,
  type WorkOrderAgentConfig,
  type WorkOrderAgentState,
  type WorkOrder,
  type ResearchResult,
  type EconomicConfig,
  type WorkOrderEvaluation,
} from '../../work-order-agent.js';
import type { AgentBrain } from '../../agent-brain.js';

@Injectable()
export class WorkOrderAgentService {
  start(config: WorkOrderAgentConfig): Promise<void> {
    return startWorkOrderAgent(config);
  }

  stop(): void {
    return stopWorkOrderAgent();
  }

  getState(): WorkOrderAgentState {
    return getWorkOrderAgentState();
  }

  resetState(): void {
    return resetWorkOrderAgentState();
  }

  runIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
    return runWorkOrderAgentIteration(config, iteration, brain);
  }

  fetchAvailable(
    coordinatorUrl: string,
    peerId: string,
    capabilities: string[],
  ): Promise<WorkOrder[]> {
    return fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
  }

  accept(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    nodeCapabilities?: string[],
  ): Promise<boolean> {
    return acceptWorkOrder(coordinatorUrl, workOrderId, peerId, nodeCapabilities);
  }

  complete(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: string,
    success?: boolean,
  ): Promise<boolean> {
    return completeWorkOrder(coordinatorUrl, workOrderId, peerId, result, success);
  }

  execute(
    workOrder: WorkOrder,
    llmModel: import('../../llm-provider.js').LLMModel,
    llmConfig?: import('../../llm-provider.js').LLMConfig,
  ): Promise<{ result: string; success: boolean }> {
    return executeWorkOrder(workOrder, llmModel, llmConfig);
  }

  executeResearch(
    workOrder: WorkOrder,
    llmModel: import('../../llm-provider.js').LLMModel,
    llmConfig?: import('../../llm-provider.js').LLMConfig,
  ): Promise<{ result: ResearchResult; rawResponse: string; success: boolean }> {
    return executeResearchWorkOrder(workOrder, llmModel, llmConfig);
  }

  isResearch(workOrder: WorkOrder): boolean {
    return isResearchWorkOrder(workOrder);
  }

  extractResearchPayload(workOrder: WorkOrder) {
    return extractResearchPayload(workOrder);
  }

  buildResearchPrompt(payload: { title: string; abstract: string }): string {
    return buildResearchPrompt(payload);
  }

  evaluate(workOrder: WorkOrder, config: EconomicConfig): WorkOrderEvaluation {
    return evaluateWorkOrder(workOrder, config);
  }

  loadEconomicConfig(runtimeModel?: string): EconomicConfig {
    return loadEconomicConfig(runtimeModel);
  }

  estimateLLMCost(abstract: string, config: EconomicConfig): number {
    return estimateLLMCost(abstract, config);
  }

  getModelCostPer1kTokens(model: string): number {
    return getModelCostPer1kTokens(model);
  }

  shouldContinueLoop(isRunning: boolean, iteration: number, maxIterations?: number): boolean {
    return shouldContinueLoop(isRunning, iteration, maxIterations);
  }

  shouldStop(iteration: number, maxIterations?: number): boolean {
    return shouldStopForMaxIterations(iteration, maxIterations);
  }

  shouldSleep(isRunning: boolean): boolean {
    return shouldSleepBetweenIterations(isRunning);
  }

  submitResearchResult(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: ResearchResult,
  ): Promise<boolean> {
    return submitResearchResult(coordinatorUrl, workOrderId, peerId, result);
  }
}
