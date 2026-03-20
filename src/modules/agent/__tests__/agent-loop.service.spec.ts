import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../agent-loop.js', () => ({
  startAgentLoop: jest.fn(),
  stopAgentLoop: jest.fn(),
  runAgentIteration: jest.fn(),
  getAgentLoopState: jest.fn(),
  resetAgentLoopState: jest.fn(),
  fetchTopExperiments: jest.fn(),
  createExperiment: jest.fn(),
  updateExperiment: jest.fn(),
  postToFeed: jest.fn(),
}));

import * as loopHelper from '../../../agent-loop.js';
import { AgentLoopService } from '../agent-loop.service.js';

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

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentLoopService();
  });

  it('start() delegates to startAgentLoop', async () => {
    (loopHelper.startAgentLoop as jest.Mock<any>).mockResolvedValue(undefined);
    await service.start(mockConfig as any);
    expect(loopHelper.startAgentLoop).toHaveBeenCalledWith(mockConfig);
  });

  it('stop() delegates to stopAgentLoop', () => {
    (loopHelper.stopAgentLoop as jest.Mock<any>).mockReturnValue(undefined);
    service.stop();
    expect(loopHelper.stopAgentLoop).toHaveBeenCalled();
  });

  it('runIteration() delegates to runAgentIteration', async () => {
    const iterResult = { improved: true, loss: 0.3 };
    (loopHelper.runAgentIteration as jest.Mock<any>).mockResolvedValue(iterResult);
    const result = await service.runIteration(mockConfig as any, 1);
    expect(loopHelper.runAgentIteration).toHaveBeenCalledWith(mockConfig, 1);
    expect(result).toBe(iterResult);
  });

  it('getState() delegates to getAgentLoopState', () => {
    (loopHelper.getAgentLoopState as jest.Mock<any>).mockReturnValue(mockState);
    const result = service.getState();
    expect(loopHelper.getAgentLoopState).toHaveBeenCalled();
    expect(result).toBe(mockState);
  });

  it('resetState() delegates to resetAgentLoopState', () => {
    (loopHelper.resetAgentLoopState as jest.Mock<any>).mockReturnValue(undefined);
    service.resetState();
    expect(loopHelper.resetAgentLoopState).toHaveBeenCalled();
  });

  it('fetchTopExperiments() delegates with defaults', async () => {
    const experiments = [{ id: 'exp-1', loss: 0.5 }];
    (loopHelper.fetchTopExperiments as jest.Mock<any>).mockResolvedValue(experiments);
    const result = await service.fetchTopExperiments('http://localhost:3001');
    expect(loopHelper.fetchTopExperiments).toHaveBeenCalledWith('http://localhost:3001', undefined);
    expect(result).toBe(experiments);
  });

  it('fetchTopExperiments() passes limit', async () => {
    (loopHelper.fetchTopExperiments as jest.Mock<any>).mockResolvedValue([]);
    await service.fetchTopExperiments('http://localhost:3001', 5);
    expect(loopHelper.fetchTopExperiments).toHaveBeenCalledWith('http://localhost:3001', 5);
  });

  it('createExperiment() delegates to createExperiment', async () => {
    (loopHelper.createExperiment as jest.Mock<any>).mockResolvedValue('exp-new-id');
    const result = await service.createExperiment('http://localhost:3001', mockProposal as any, 'peer-1', 1);
    expect(loopHelper.createExperiment).toHaveBeenCalledWith('http://localhost:3001', mockProposal, 'peer-1', 1);
    expect(result).toBe('exp-new-id');
  });

  it('updateExperiment() delegates to updateExperiment', async () => {
    (loopHelper.updateExperiment as jest.Mock<any>).mockResolvedValue(undefined);
    await service.updateExperiment('http://localhost:3001', 'exp-1', mockTrainingResult as any);
    expect(loopHelper.updateExperiment).toHaveBeenCalledWith('http://localhost:3001', 'exp-1', mockTrainingResult);
  });

  it('postToFeed() delegates to postToFeed', async () => {
    (loopHelper.postToFeed as jest.Mock<any>).mockResolvedValue(undefined);
    await service.postToFeed('http://localhost:3001', 'peer-1', mockProposal as any, mockTrainingResult as any, true);
    expect(loopHelper.postToFeed).toHaveBeenCalledWith(
      'http://localhost:3001',
      'peer-1',
      mockProposal,
      mockTrainingResult,
      true,
    );
  });
});
