import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { WorkOrderAgentService } from '../work-order-agent.service.js';
import { WorkOrderAgentHelper } from '../helpers/work-order-agent.js';

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
  let workOrderAgentHelper: jest.Mocked<WorkOrderAgentHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        WorkOrderAgentService,
        {
          provide: WorkOrderAgentHelper,
          useValue: {
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
          },
        },
      ],
    }).compile();

    service = module.get<WorkOrderAgentService>(WorkOrderAgentService);
    workOrderAgentHelper = module.get(WorkOrderAgentHelper);
  });

  it('start() delegates to workOrderAgentHelper.startWorkOrderAgent', async () => {
    workOrderAgentHelper.startWorkOrderAgent.mockResolvedValue(undefined);
    await service.start(mockConfig as any);
    expect(workOrderAgentHelper.startWorkOrderAgent).toHaveBeenCalledWith(mockConfig);
  });

  it('stop() delegates to workOrderAgentHelper.stopWorkOrderAgent', () => {
    workOrderAgentHelper.stopWorkOrderAgent.mockReturnValue(undefined as any);
    service.stop();
    expect(workOrderAgentHelper.stopWorkOrderAgent).toHaveBeenCalled();
  });

  it('getState() delegates to workOrderAgentHelper.getWorkOrderAgentState', () => {
    workOrderAgentHelper.getWorkOrderAgentState.mockReturnValue(mockState as any);
    const result = service.getState();
    expect(workOrderAgentHelper.getWorkOrderAgentState).toHaveBeenCalled();
    expect(result).toBe(mockState);
  });

  it('resetState() delegates to workOrderAgentHelper.resetWorkOrderAgentState', () => {
    workOrderAgentHelper.resetWorkOrderAgentState.mockReturnValue(undefined as any);
    service.resetState();
    expect(workOrderAgentHelper.resetWorkOrderAgentState).toHaveBeenCalled();
  });

  it('runIteration() delegates to workOrderAgentHelper.runWorkOrderAgentIteration', async () => {
    const iterResult = { completed: true, workOrder: mockWorkOrder };
    workOrderAgentHelper.runWorkOrderAgentIteration.mockResolvedValue(iterResult as any);
    const result = await service.runIteration(mockConfig as any, 1);
    expect(workOrderAgentHelper.runWorkOrderAgentIteration).toHaveBeenCalledWith(mockConfig, 1, undefined);
    expect(result).toBe(iterResult);
  });

  it('runIteration() passes brain', async () => {
    const mockBrain = { goals: [], memories: [], journal: [] };
    workOrderAgentHelper.runWorkOrderAgentIteration.mockResolvedValue({ completed: false } as any);
    await service.runIteration(mockConfig as any, 2, mockBrain as any);
    expect(workOrderAgentHelper.runWorkOrderAgentIteration).toHaveBeenCalledWith(mockConfig, 2, mockBrain);
  });

  it('fetchAvailable() delegates to workOrderAgentHelper.fetchAvailableWorkOrders', async () => {
    workOrderAgentHelper.fetchAvailableWorkOrders.mockResolvedValue([mockWorkOrder] as any);
    const result = await service.fetchAvailable('http://localhost:3001', 'peer-1', ['cpu']);
    expect(workOrderAgentHelper.fetchAvailableWorkOrders).toHaveBeenCalledWith('http://localhost:3001', 'peer-1', ['cpu']);
    expect(result).toEqual([mockWorkOrder]);
  });

  it('accept() delegates to workOrderAgentHelper.acceptWorkOrder', async () => {
    workOrderAgentHelper.acceptWorkOrder.mockResolvedValue(true);
    const result = await service.accept('http://localhost:3001', 'wo-1', 'peer-1', ['cpu']);
    expect(workOrderAgentHelper.acceptWorkOrder).toHaveBeenCalledWith('http://localhost:3001', 'wo-1', 'peer-1', ['cpu']);
    expect(result).toBe(true);
  });

  it('complete() delegates to workOrderAgentHelper.completeWorkOrder', async () => {
    workOrderAgentHelper.completeWorkOrder.mockResolvedValue(true);
    const result = await service.complete('http://localhost:3001', 'wo-1', 'peer-1', 'done', true);
    expect(workOrderAgentHelper.completeWorkOrder).toHaveBeenCalledWith('http://localhost:3001', 'wo-1', 'peer-1', 'done', true);
    expect(result).toBe(true);
  });

  it('execute() delegates to workOrderAgentHelper.executeWorkOrder', async () => {
    const execResult = { result: 'answer', success: true };
    const model = { provider: 'ollama', modelId: 'qwen2.5:0.5b' };
    workOrderAgentHelper.executeWorkOrder.mockResolvedValue(execResult as any);
    const result = await service.execute(mockWorkOrder as any, model as any);
    expect(workOrderAgentHelper.executeWorkOrder).toHaveBeenCalledWith(mockWorkOrder, model, undefined);
    expect(result).toBe(execResult);
  });

  it('executeResearch() delegates to workOrderAgentHelper.executeResearchWorkOrder', async () => {
    const researchResult = { result: mockResearchResult, rawResponse: 'raw', success: true };
    const model = { provider: 'ollama', modelId: 'qwen2.5:0.5b' };
    workOrderAgentHelper.executeResearchWorkOrder.mockResolvedValue(researchResult as any);
    const result = await service.executeResearch(mockWorkOrder as any, model as any);
    expect(workOrderAgentHelper.executeResearchWorkOrder).toHaveBeenCalledWith(mockWorkOrder, model, undefined);
    expect(result).toBe(researchResult);
  });

  it('isResearch() delegates to workOrderAgentHelper.isResearchWorkOrder', () => {
    workOrderAgentHelper.isResearchWorkOrder.mockReturnValue(true);
    const result = service.isResearch(mockWorkOrder as any);
    expect(workOrderAgentHelper.isResearchWorkOrder).toHaveBeenCalledWith(mockWorkOrder);
    expect(result).toBe(true);
  });

  it('extractResearchPayload() delegates to workOrderAgentHelper.extractResearchPayload', () => {
    const payload = { title: 'Test', abstract: 'Abstract' };
    workOrderAgentHelper.extractResearchPayload.mockReturnValue(payload as any);
    const result = service.extractResearchPayload(mockWorkOrder as any);
    expect(workOrderAgentHelper.extractResearchPayload).toHaveBeenCalledWith(mockWorkOrder);
    expect(result).toBe(payload);
  });

  it('buildResearchPrompt() delegates to workOrderAgentHelper.buildResearchPrompt', () => {
    workOrderAgentHelper.buildResearchPrompt.mockReturnValue('Analyze this paper: Test');
    const result = service.buildResearchPrompt({ title: 'Test', abstract: 'Abstract' });
    expect(workOrderAgentHelper.buildResearchPrompt).toHaveBeenCalledWith({ title: 'Test', abstract: 'Abstract' });
    expect(result).toBe('Analyze this paper: Test');
  });

  it('evaluate() delegates to workOrderAgentHelper.evaluateWorkOrder', () => {
    const evaluation = { shouldAccept: true, estimatedCost: 0.5, expectedReward: 10, profitability: 19 };
    workOrderAgentHelper.evaluateWorkOrder.mockReturnValue(evaluation as any);
    const result = service.evaluate(mockWorkOrder as any, mockEconomicConfig as any);
    expect(workOrderAgentHelper.evaluateWorkOrder).toHaveBeenCalledWith(mockWorkOrder, mockEconomicConfig);
    expect(result).toBe(evaluation);
  });

  it('loadEconomicConfig() delegates to workOrderAgentHelper.loadEconomicConfig', () => {
    workOrderAgentHelper.loadEconomicConfig.mockReturnValue(mockEconomicConfig as any);
    const result = service.loadEconomicConfig('ollama/qwen2.5:0.5b');
    expect(workOrderAgentHelper.loadEconomicConfig).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(mockEconomicConfig);
  });

  it('loadEconomicConfig() works without model', () => {
    workOrderAgentHelper.loadEconomicConfig.mockReturnValue(mockEconomicConfig as any);
    service.loadEconomicConfig();
    expect(workOrderAgentHelper.loadEconomicConfig).toHaveBeenCalledWith(undefined);
  });

  it('estimateLLMCost() delegates to workOrderAgentHelper.estimateLLMCost', () => {
    workOrderAgentHelper.estimateLLMCost.mockReturnValue(0.002);
    const result = service.estimateLLMCost('This is a test abstract', mockEconomicConfig as any);
    expect(workOrderAgentHelper.estimateLLMCost).toHaveBeenCalledWith('This is a test abstract', mockEconomicConfig);
    expect(result).toBe(0.002);
  });

  it('getModelCostPer1kTokens() delegates to workOrderAgentHelper.getModelCostPer1kTokens', () => {
    workOrderAgentHelper.getModelCostPer1kTokens.mockReturnValue(0.0001);
    const result = service.getModelCostPer1kTokens('ollama/qwen2.5:0.5b');
    expect(workOrderAgentHelper.getModelCostPer1kTokens).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(0.0001);
  });

  it('shouldContinueLoop() delegates to workOrderAgentHelper.shouldContinueLoop - true', () => {
    workOrderAgentHelper.shouldContinueLoop.mockReturnValue(true);
    const result = service.shouldContinueLoop(true, 5, 100);
    expect(workOrderAgentHelper.shouldContinueLoop).toHaveBeenCalledWith(true, 5, 100);
    expect(result).toBe(true);
  });

  it('shouldStop() delegates to workOrderAgentHelper.shouldStopForMaxIterations', () => {
    workOrderAgentHelper.shouldStopForMaxIterations.mockReturnValue(true);
    const result = service.shouldStop(100, 100);
    expect(workOrderAgentHelper.shouldStopForMaxIterations).toHaveBeenCalledWith(100, 100);
    expect(result).toBe(true);
  });

  it('shouldSleep() delegates to workOrderAgentHelper.shouldSleepBetweenIterations', () => {
    workOrderAgentHelper.shouldSleepBetweenIterations.mockReturnValue(false);
    const result = service.shouldSleep(true);
    expect(workOrderAgentHelper.shouldSleepBetweenIterations).toHaveBeenCalledWith(true);
    expect(result).toBe(false);
  });

  it('submitResearchResult() delegates to workOrderAgentHelper.submitResearchResult', async () => {
    workOrderAgentHelper.submitResearchResult.mockResolvedValue(true);
    const result = await service.submitResearchResult(
      'http://localhost:3001',
      'wo-1',
      'peer-1',
      mockResearchResult as any,
    );
    expect(workOrderAgentHelper.submitResearchResult).toHaveBeenCalledWith(
      'http://localhost:3001',
      'wo-1',
      'peer-1',
      mockResearchResult,
    );
    expect(result).toBe(true);
  });
});
