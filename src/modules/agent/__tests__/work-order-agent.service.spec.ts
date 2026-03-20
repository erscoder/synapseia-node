import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../work-order-agent.js', () => ({
  startWorkOrderAgent: jest.fn(),
  stopWorkOrderAgent: jest.fn(),
  getWorkOrderAgentState: jest.fn(),
  resetWorkOrderAgentState: jest.fn(),
  runWorkOrderAgentIteration: jest.fn(),
  fetchAvailableWorkOrders: jest.fn(),
  acceptWorkOrder: jest.fn(),
  completeWorkOrder: jest.fn(),
  executeWorkOrder: jest.fn(),
  executeResearchWorkOrder: jest.fn(),
  submitResearchResult: jest.fn(),
  isResearchWorkOrder: jest.fn(),
  extractResearchPayload: jest.fn(),
  buildResearchPrompt: jest.fn(),
  evaluateWorkOrder: jest.fn(),
  loadEconomicConfig: jest.fn(),
  estimateLLMCost: jest.fn(),
  getModelCostPer1kTokens: jest.fn(),
  shouldContinueLoop: jest.fn(),
  shouldStopForMaxIterations: jest.fn(),
  shouldSleepBetweenIterations: jest.fn(),
}));

import * as woaHelper from '../../../work-order-agent.js';
import { WorkOrderAgentService } from '../work-order-agent.service.js';

const mockConfig = {
  coordinatorUrl: 'http://localhost:3001',
  peerId: 'peer-1',
  capabilities: ['cpu'],
};

const mockWorkOrder = {
  id: 'wo-1',
  type: 'research',
  payload: { title: 'Test Paper', abstract: 'Test abstract' },
  reward: 10,
};

const mockState = {
  isRunning: false,
  iteration: 0,
  completedOrders: 0,
};

const mockEconomicConfig = {
  minRewardThreshold: 5,
  maxCostPerTask: 2,
  model: 'ollama/qwen2.5:0.5b',
};

const mockResearchResult = {
  summary: 'paper summary',
  keyFindings: ['finding1'],
  methodology: 'method',
  quality: 0.8,
};

describe('WorkOrderAgentService', () => {
  let service: WorkOrderAgentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WorkOrderAgentService();
  });

  it('start() delegates to startWorkOrderAgent', async () => {
    (woaHelper.startWorkOrderAgent as jest.Mock<any>).mockResolvedValue(undefined);
    await service.start(mockConfig as any);
    expect(woaHelper.startWorkOrderAgent).toHaveBeenCalledWith(mockConfig);
  });

  it('stop() delegates to stopWorkOrderAgent', () => {
    (woaHelper.stopWorkOrderAgent as jest.Mock<any>).mockReturnValue(undefined);
    service.stop();
    expect(woaHelper.stopWorkOrderAgent).toHaveBeenCalled();
  });

  it('getState() delegates to getWorkOrderAgentState', () => {
    (woaHelper.getWorkOrderAgentState as jest.Mock<any>).mockReturnValue(mockState);
    const result = service.getState();
    expect(woaHelper.getWorkOrderAgentState).toHaveBeenCalled();
    expect(result).toBe(mockState);
  });

  it('resetState() delegates to resetWorkOrderAgentState', () => {
    (woaHelper.resetWorkOrderAgentState as jest.Mock<any>).mockReturnValue(undefined);
    service.resetState();
    expect(woaHelper.resetWorkOrderAgentState).toHaveBeenCalled();
  });

  it('runIteration() delegates to runWorkOrderAgentIteration', async () => {
    const iterResult = { completed: true, workOrder: mockWorkOrder };
    (woaHelper.runWorkOrderAgentIteration as jest.Mock<any>).mockResolvedValue(iterResult);
    const result = await service.runIteration(mockConfig as any, 1);
    expect(woaHelper.runWorkOrderAgentIteration).toHaveBeenCalledWith(mockConfig, 1, undefined);
    expect(result).toBe(iterResult);
  });

  it('runIteration() passes brain', async () => {
    const mockBrain = { goals: [], memories: [], journal: [] };
    (woaHelper.runWorkOrderAgentIteration as jest.Mock<any>).mockResolvedValue({ completed: false });
    await service.runIteration(mockConfig as any, 2, mockBrain as any);
    expect(woaHelper.runWorkOrderAgentIteration).toHaveBeenCalledWith(mockConfig, 2, mockBrain);
  });

  it('fetchAvailable() delegates to fetchAvailableWorkOrders', async () => {
    (woaHelper.fetchAvailableWorkOrders as jest.Mock<any>).mockResolvedValue([mockWorkOrder]);
    const result = await service.fetchAvailable('http://localhost:3001', 'peer-1', ['cpu']);
    expect(woaHelper.fetchAvailableWorkOrders).toHaveBeenCalledWith('http://localhost:3001', 'peer-1', ['cpu']);
    expect(result).toEqual([mockWorkOrder]);
  });

  it('accept() delegates to acceptWorkOrder', async () => {
    (woaHelper.acceptWorkOrder as jest.Mock<any>).mockResolvedValue(true);
    const result = await service.accept('http://localhost:3001', 'wo-1', 'peer-1', ['cpu']);
    expect(woaHelper.acceptWorkOrder).toHaveBeenCalledWith('http://localhost:3001', 'wo-1', 'peer-1', ['cpu']);
    expect(result).toBe(true);
  });

  it('complete() delegates to completeWorkOrder', async () => {
    (woaHelper.completeWorkOrder as jest.Mock<any>).mockResolvedValue(true);
    const result = await service.complete('http://localhost:3001', 'wo-1', 'peer-1', 'done', true);
    expect(woaHelper.completeWorkOrder).toHaveBeenCalledWith('http://localhost:3001', 'wo-1', 'peer-1', 'done', true);
    expect(result).toBe(true);
  });

  it('execute() delegates to executeWorkOrder', async () => {
    const execResult = { result: 'answer', success: true };
    const model = { provider: 'ollama', modelId: 'qwen2.5:0.5b' };
    (woaHelper.executeWorkOrder as jest.Mock<any>).mockResolvedValue(execResult);
    const result = await service.execute(mockWorkOrder as any, model as any);
    expect(woaHelper.executeWorkOrder).toHaveBeenCalledWith(mockWorkOrder, model, undefined);
    expect(result).toBe(execResult);
  });

  it('executeResearch() delegates to executeResearchWorkOrder', async () => {
    const researchResult = { result: mockResearchResult, rawResponse: 'raw', success: true };
    const model = { provider: 'ollama', modelId: 'qwen2.5:0.5b' };
    (woaHelper.executeResearchWorkOrder as jest.Mock<any>).mockResolvedValue(researchResult);
    const result = await service.executeResearch(mockWorkOrder as any, model as any);
    expect(woaHelper.executeResearchWorkOrder).toHaveBeenCalledWith(mockWorkOrder, model, undefined);
    expect(result).toBe(researchResult);
  });

  it('isResearch() delegates to isResearchWorkOrder', () => {
    (woaHelper.isResearchWorkOrder as jest.Mock<any>).mockReturnValue(true);
    const result = service.isResearch(mockWorkOrder as any);
    expect(woaHelper.isResearchWorkOrder).toHaveBeenCalledWith(mockWorkOrder);
    expect(result).toBe(true);
  });

  it('extractResearchPayload() delegates to extractResearchPayload', () => {
    const payload = { title: 'Test', abstract: 'Abstract' };
    (woaHelper.extractResearchPayload as jest.Mock<any>).mockReturnValue(payload);
    const result = service.extractResearchPayload(mockWorkOrder as any);
    expect(woaHelper.extractResearchPayload).toHaveBeenCalledWith(mockWorkOrder);
    expect(result).toBe(payload);
  });

  it('buildResearchPrompt() delegates to buildResearchPrompt', () => {
    (woaHelper.buildResearchPrompt as jest.Mock<any>).mockReturnValue('Analyze this paper: Test');
    const result = service.buildResearchPrompt({ title: 'Test', abstract: 'Abstract' });
    expect(woaHelper.buildResearchPrompt).toHaveBeenCalledWith({ title: 'Test', abstract: 'Abstract' });
    expect(result).toBe('Analyze this paper: Test');
  });

  it('evaluate() delegates to evaluateWorkOrder', () => {
    const evaluation = { shouldAccept: true, estimatedCost: 0.5, expectedReward: 10, profitability: 19 };
    (woaHelper.evaluateWorkOrder as jest.Mock<any>).mockReturnValue(evaluation);
    const result = service.evaluate(mockWorkOrder as any, mockEconomicConfig as any);
    expect(woaHelper.evaluateWorkOrder).toHaveBeenCalledWith(mockWorkOrder, mockEconomicConfig);
    expect(result).toBe(evaluation);
  });

  it('loadEconomicConfig() delegates to loadEconomicConfig', () => {
    (woaHelper.loadEconomicConfig as jest.Mock<any>).mockReturnValue(mockEconomicConfig);
    const result = service.loadEconomicConfig('ollama/qwen2.5:0.5b');
    expect(woaHelper.loadEconomicConfig).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(mockEconomicConfig);
  });

  it('loadEconomicConfig() works without model', () => {
    (woaHelper.loadEconomicConfig as jest.Mock<any>).mockReturnValue(mockEconomicConfig);
    service.loadEconomicConfig();
    expect(woaHelper.loadEconomicConfig).toHaveBeenCalledWith(undefined);
  });

  it('estimateLLMCost() delegates to estimateLLMCost', () => {
    (woaHelper.estimateLLMCost as jest.Mock<any>).mockReturnValue(0.002);
    const result = service.estimateLLMCost('This is a test abstract', mockEconomicConfig as any);
    expect(woaHelper.estimateLLMCost).toHaveBeenCalledWith('This is a test abstract', mockEconomicConfig);
    expect(result).toBe(0.002);
  });

  it('getModelCostPer1kTokens() delegates to getModelCostPer1kTokens', () => {
    (woaHelper.getModelCostPer1kTokens as jest.Mock<any>).mockReturnValue(0.0001);
    const result = service.getModelCostPer1kTokens('ollama/qwen2.5:0.5b');
    expect(woaHelper.getModelCostPer1kTokens).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(0.0001);
  });

  it('shouldContinueLoop() delegates to shouldContinueLoop - true', () => {
    (woaHelper.shouldContinueLoop as jest.Mock<any>).mockReturnValue(true);
    const result = service.shouldContinueLoop(true, 5, 100);
    expect(woaHelper.shouldContinueLoop).toHaveBeenCalledWith(true, 5, 100);
    expect(result).toBe(true);
  });

  it('shouldStop() delegates to shouldStopForMaxIterations', () => {
    (woaHelper.shouldStopForMaxIterations as jest.Mock<any>).mockReturnValue(true);
    const result = service.shouldStop(100, 100);
    expect(woaHelper.shouldStopForMaxIterations).toHaveBeenCalledWith(100, 100);
    expect(result).toBe(true);
  });

  it('shouldSleep() delegates to shouldSleepBetweenIterations', () => {
    (woaHelper.shouldSleepBetweenIterations as jest.Mock<any>).mockReturnValue(false);
    const result = service.shouldSleep(true);
    expect(woaHelper.shouldSleepBetweenIterations).toHaveBeenCalledWith(true);
    expect(result).toBe(false);
  });

  it('submitResearchResult() delegates to submitResearchResult', async () => {
    (woaHelper.submitResearchResult as jest.Mock<any>).mockResolvedValue(true);
    const result = await service.submitResearchResult(
      'http://localhost:3001',
      'wo-1',
      'peer-1',
      mockResearchResult as any,
    );
    expect(woaHelper.submitResearchResult).toHaveBeenCalledWith(
      'http://localhost:3001',
      'wo-1',
      'peer-1',
      mockResearchResult,
    );
    expect(result).toBe(true);
  });
});
