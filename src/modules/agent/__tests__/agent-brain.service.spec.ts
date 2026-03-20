import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../agent-brain.js', () => ({
  initBrain: jest.fn(),
  updateBrain: jest.fn(),
  getNextAction: jest.fn(),
  getRecentMemories: jest.fn(),
  getRecentJournal: jest.fn(),
}));

import * as brainHelper from '../../../agent-brain.js';
import { AgentBrainService } from '../agent-brain.service.js';

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

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentBrainService();
  });

  it('init() delegates to initBrain without goals', () => {
    (brainHelper.initBrain as jest.Mock<any>).mockReturnValue(mockBrain);
    const result = service.init();
    expect(brainHelper.initBrain).toHaveBeenCalledWith(undefined);
    expect(result).toBe(mockBrain);
  });

  it('init() passes goals', () => {
    (brainHelper.initBrain as jest.Mock<any>).mockReturnValue(mockBrain);
    service.init(['goal1', 'goal2']);
    expect(brainHelper.initBrain).toHaveBeenCalledWith(['goal1', 'goal2']);
  });

  it('update() delegates to updateBrain', () => {
    const updatedBrain = { ...mockBrain, totalIterations: 1 };
    const result_data = { valLoss: 0.3, improved: true, mutation: 'lr_change', lesson: 'lower lr helps' };
    (brainHelper.updateBrain as jest.Mock<any>).mockReturnValue(updatedBrain);
    const result = service.update(mockBrain as any, result_data);
    expect(brainHelper.updateBrain).toHaveBeenCalledWith(mockBrain, result_data);
    expect(result).toBe(updatedBrain);
  });

  it('update() works without lesson', () => {
    (brainHelper.updateBrain as jest.Mock<any>).mockReturnValue(mockBrain);
    service.update(mockBrain as any, { valLoss: 0.5, improved: false, mutation: 'none' });
    expect(brainHelper.updateBrain).toHaveBeenCalledWith(mockBrain, { valLoss: 0.5, improved: false, mutation: 'none' });
  });

  it('getNextAction() delegates to getNextAction - explore', () => {
    (brainHelper.getNextAction as jest.Mock<any>).mockReturnValue('explore');
    const result = service.getNextAction(mockBrain as any);
    expect(brainHelper.getNextAction).toHaveBeenCalledWith(mockBrain);
    expect(result).toBe('explore');
  });

  it('getNextAction() returns improve', () => {
    (brainHelper.getNextAction as jest.Mock<any>).mockReturnValue('improve');
    const result = service.getNextAction(mockBrain as any);
    expect(result).toBe('improve');
  });

  it('getNextAction() returns rest', () => {
    (brainHelper.getNextAction as jest.Mock<any>).mockReturnValue('rest');
    const result = service.getNextAction(mockBrain as any);
    expect(result).toBe('rest');
  });

  it('getRecentMemories() delegates with defaults', () => {
    const memories = [{ content: 'memory1', importance: 5, timestamp: Date.now() }];
    (brainHelper.getRecentMemories as jest.Mock<any>).mockReturnValue(memories);
    const result = service.getRecentMemories(mockBrain as any);
    expect(brainHelper.getRecentMemories).toHaveBeenCalledWith(mockBrain, undefined, undefined);
    expect(result).toBe(memories);
  });

  it('getRecentMemories() passes maxEntries and minImportance', () => {
    (brainHelper.getRecentMemories as jest.Mock<any>).mockReturnValue([]);
    service.getRecentMemories(mockBrain as any, 5, 3);
    expect(brainHelper.getRecentMemories).toHaveBeenCalledWith(mockBrain, 5, 3);
  });

  it('getRecentJournal() delegates with defaults', () => {
    const journal = [{ entry: 'log1', timestamp: Date.now() }];
    (brainHelper.getRecentJournal as jest.Mock<any>).mockReturnValue(journal);
    const result = service.getRecentJournal(mockBrain as any);
    expect(brainHelper.getRecentJournal).toHaveBeenCalledWith(mockBrain, undefined);
    expect(result).toBe(journal);
  });

  it('getRecentJournal() passes maxEntries', () => {
    (brainHelper.getRecentJournal as jest.Mock<any>).mockReturnValue([]);
    service.getRecentJournal(mockBrain as any, 10);
    expect(brainHelper.getRecentJournal).toHaveBeenCalledWith(mockBrain, 10);
  });
});
