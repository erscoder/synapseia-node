import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { AgentLoopService } from '../agent-loop.service.js';
import { AgentLoopHelper } from '../helpers/agent-loop.js';

const mockConfig = {
  coordinatorUrl: 'http://localhost:3001',
  peerId: 'peer-1',
  tier: 1,
  capabilities: ['cpu'],
};

const mockState = {
  isRunning: false,
  iteration: 0,
  bestLoss: Infinity,
};

const mockProposal = {
  mutationType: 'learning_rate',
  parameters: { lr: 0.001 },
  reasoning: 'try lower lr',
};

const mockTrainingResult = {
  valLoss: 0.3,
  improved: true,
  modelPath: '/tmp/model',
};

describe('AgentLoopService', () => {
  let service: AgentLoopService;
  let agentLoopHelper: jest.Mocked<AgentLoopHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AgentLoopService,
        {
          provide: AgentLoopHelper,
          useValue: {
            startAgentLoop: jest.fn(),
            stopAgentLoop: jest.fn(),
            runAgentIteration: jest.fn(),
            getAgentLoopState: jest.fn(),
            resetAgentLoopState: jest.fn(),
            fetchTopExperiments: jest.fn(),
            createExperiment: jest.fn(),
            updateExperiment: jest.fn(),
            postToFeed: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AgentLoopService>(AgentLoopService);
    agentLoopHelper = module.get(AgentLoopHelper);
  });

  it('start() delegates to agentLoopHelper.startAgentLoop', async () => {
    agentLoopHelper.startAgentLoop.mockResolvedValue(undefined);
    await service.start(mockConfig as any);
    expect(agentLoopHelper.startAgentLoop).toHaveBeenCalledWith(mockConfig);
  });

  it('stop() delegates to agentLoopHelper.stopAgentLoop', () => {
    agentLoopHelper.stopAgentLoop.mockReturnValue(undefined as any);
    service.stop();
    expect(agentLoopHelper.stopAgentLoop).toHaveBeenCalled();
  });

  it('runIteration() delegates to agentLoopHelper.runAgentIteration', async () => {
    const iterResult = { improved: true, loss: 0.3 };
    agentLoopHelper.runAgentIteration.mockResolvedValue(iterResult as any);
    const result = await service.runIteration(mockConfig as any, 1);
    expect(agentLoopHelper.runAgentIteration).toHaveBeenCalledWith(mockConfig, 1);
    expect(result).toBe(iterResult);
  });

  it('getState() delegates to agentLoopHelper.getAgentLoopState', () => {
    agentLoopHelper.getAgentLoopState.mockReturnValue(mockState as any);
    const result = service.getState();
    expect(agentLoopHelper.getAgentLoopState).toHaveBeenCalled();
    expect(result).toBe(mockState);
  });

  it('resetState() delegates to agentLoopHelper.resetAgentLoopState', () => {
    agentLoopHelper.resetAgentLoopState.mockReturnValue(undefined as any);
    service.resetState();
    expect(agentLoopHelper.resetAgentLoopState).toHaveBeenCalled();
  });

  it('fetchTopExperiments() delegates with defaults', async () => {
    const experiments = [{ id: 'exp-1', loss: 0.5 }];
    agentLoopHelper.fetchTopExperiments.mockResolvedValue(experiments as any);
    const result = await service.fetchTopExperiments('http://localhost:3001');
    expect(agentLoopHelper.fetchTopExperiments).toHaveBeenCalledWith('http://localhost:3001', undefined);
    expect(result).toBe(experiments);
  });

  it('fetchTopExperiments() passes limit', async () => {
    agentLoopHelper.fetchTopExperiments.mockResolvedValue([]);
    await service.fetchTopExperiments('http://localhost:3001', 5);
    expect(agentLoopHelper.fetchTopExperiments).toHaveBeenCalledWith('http://localhost:3001', 5);
  });

  it('createExperiment() delegates to agentLoopHelper.createExperiment', async () => {
    agentLoopHelper.createExperiment.mockResolvedValue('exp-new-id');
    const result = await service.createExperiment('http://localhost:3001', mockProposal as any, 'peer-1', 1);
    expect(agentLoopHelper.createExperiment).toHaveBeenCalledWith('http://localhost:3001', mockProposal, 'peer-1', 1);
    expect(result).toBe('exp-new-id');
  });

  it('updateExperiment() delegates to agentLoopHelper.updateExperiment', async () => {
    agentLoopHelper.updateExperiment.mockResolvedValue(undefined);
    await service.updateExperiment('http://localhost:3001', 'exp-1', mockTrainingResult as any);
    expect(agentLoopHelper.updateExperiment).toHaveBeenCalledWith('http://localhost:3001', 'exp-1', mockTrainingResult);
  });

  it('postToFeed() delegates to agentLoopHelper.postToFeed', async () => {
    agentLoopHelper.postToFeed.mockResolvedValue(undefined);
    await service.postToFeed('http://localhost:3001', 'peer-1', mockProposal as any, mockTrainingResult as any, true);
    expect(agentLoopHelper.postToFeed).toHaveBeenCalledWith(
      'http://localhost:3001',
      'peer-1',
      mockProposal,
      mockTrainingResult,
      true,
    );
  });
});
