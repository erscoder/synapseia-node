import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { AgentBrainService } from '../agent-brain.service.js';
import { AgentBrainHelper } from '../../../agent-brain.js';

const mockBrain = {
  goals: ['improve model accuracy'],
  memories: [],
  journal: [],
  consecutiveNoImprovement: 0,
  totalIterations: 0,
  bestLoss: Infinity,
};

describe('AgentBrainService', () => {
  let service: AgentBrainService;
  let agentBrainHelper: jest.Mocked<AgentBrainHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AgentBrainService,
        {
          provide: AgentBrainHelper,
          useValue: {
            initBrain: jest.fn(),
            updateBrain: jest.fn(),
            getNextAction: jest.fn(),
            getRecentMemories: jest.fn(),
            getRecentJournal: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AgentBrainService>(AgentBrainService);
    agentBrainHelper = module.get(AgentBrainHelper);
  });

  it('init() delegates to agentBrainHelper.initBrain without goals', () => {
    agentBrainHelper.initBrain.mockReturnValue(mockBrain as any);
    const result = service.init();
    expect(agentBrainHelper.initBrain).toHaveBeenCalledWith(undefined);
    expect(result).toBe(mockBrain);
  });

  it('init() passes goals', () => {
    agentBrainHelper.initBrain.mockReturnValue(mockBrain as any);
    service.init(['goal1', 'goal2']);
    expect(agentBrainHelper.initBrain).toHaveBeenCalledWith(['goal1', 'goal2']);
  });

  it('update() delegates to agentBrainHelper.updateBrain', () => {
    const updatedBrain = { ...mockBrain, totalIterations: 1 };
    const result_data = { valLoss: 0.3, improved: true, mutation: 'lr_change', lesson: 'lower lr helps' };
    agentBrainHelper.updateBrain.mockReturnValue(updatedBrain as any);
    const result = service.update(mockBrain as any, result_data);
    expect(agentBrainHelper.updateBrain).toHaveBeenCalledWith(mockBrain, result_data);
    expect(result).toBe(updatedBrain);
  });

  it('update() works without lesson', () => {
    agentBrainHelper.updateBrain.mockReturnValue(mockBrain as any);
    service.update(mockBrain as any, { valLoss: 0.5, improved: false, mutation: 'none' });
    expect(agentBrainHelper.updateBrain).toHaveBeenCalledWith(mockBrain, { valLoss: 0.5, improved: false, mutation: 'none' });
  });

  it('getNextAction() delegates to agentBrainHelper - explore', () => {
    agentBrainHelper.getNextAction.mockReturnValue('explore');
    const result = service.getNextAction(mockBrain as any);
    expect(agentBrainHelper.getNextAction).toHaveBeenCalledWith(mockBrain);
    expect(result).toBe('explore');
  });

  it('getNextAction() returns improve', () => {
    agentBrainHelper.getNextAction.mockReturnValue('improve');
    const result = service.getNextAction(mockBrain as any);
    expect(result).toBe('improve');
  });

  it('getNextAction() returns rest', () => {
    agentBrainHelper.getNextAction.mockReturnValue('rest');
    const result = service.getNextAction(mockBrain as any);
    expect(result).toBe('rest');
  });

  it('getRecentMemories() delegates with defaults', () => {
    const memories = [{ content: 'memory1', importance: 5, timestamp: Date.now() }];
    agentBrainHelper.getRecentMemories.mockReturnValue(memories as any);
    const result = service.getRecentMemories(mockBrain as any);
    expect(agentBrainHelper.getRecentMemories).toHaveBeenCalledWith(mockBrain, undefined, undefined);
    expect(result).toBe(memories);
  });

  it('getRecentMemories() passes maxEntries and minImportance', () => {
    agentBrainHelper.getRecentMemories.mockReturnValue([]);
    service.getRecentMemories(mockBrain as any, 5, 3);
    expect(agentBrainHelper.getRecentMemories).toHaveBeenCalledWith(mockBrain, 5, 3);
  });

  it('getRecentJournal() delegates with defaults', () => {
    const journal = [{ entry: 'log1', timestamp: Date.now() }];
    agentBrainHelper.getRecentJournal.mockReturnValue(journal as any);
    const result = service.getRecentJournal(mockBrain as any);
    expect(agentBrainHelper.getRecentJournal).toHaveBeenCalledWith(mockBrain, undefined);
    expect(result).toBe(journal);
  });

  it('getRecentJournal() passes maxEntries', () => {
    agentBrainHelper.getRecentJournal.mockReturnValue([]);
    service.getRecentJournal(mockBrain as any, 10);
    expect(agentBrainHelper.getRecentJournal).toHaveBeenCalledWith(mockBrain, 10);
  });
});
