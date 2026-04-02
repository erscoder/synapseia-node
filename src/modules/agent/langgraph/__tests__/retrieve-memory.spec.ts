/**
 * Unit tests for RetrieveMemoryNode
 * Sprint B - Planning + Self-Critique
 */

import { jest } from '@jest/globals';
import { RetrieveMemoryNode } from '../nodes/retrieve-memory';
import type { AgentState, MemoryEntry } from '../state';

// Mock logger to avoid console output during tests
jest.mock('../../../../utils/logger', () => ({
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('RetrieveMemoryNode', () => {
  let node: RetrieveMemoryNode;

  beforeEach(() => {
    node = new RetrieveMemoryNode();
  });

  function makeState(overrides: Partial<AgentState> = {}): AgentState {
    return {
      availableWorkOrders: [],
      selectedWorkOrder: null,
      economicEvaluation: null,
      executionResult: null,
      researchResult: null,
      qualityScore: 0,
      shouldSubmit: false,
      submitted: false,
      accepted: false,
      brain: { memory: [], goals: [], journal: [], strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 }, totalExperiments: 0, bestResult: null },
      iteration: 1,
      config: {
        coordinatorUrl: 'http://localhost:3701',
        peerId: 'peer1',
        capabilities: ['llm'],
        llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: '' },
        intervalMs: 5000,
      },
      coordinatorUrl: 'http://localhost:3701',
      peerId: 'peer1',
      capabilities: ['llm'],
      // Sprint B fields
      relevantMemories: [],
      executionPlan: [],
      currentStepIndex: 0,
      selfCritiqueScore: 0,
      selfCritiquePassed: false,
      selfCritiqueFeedback: '',
      retryCount: 0,
      ...overrides,
    };
  }

  describe('when brain has no memories', () => {
    it('should return empty array', async () => {
      const state = makeState({
        brain: { memory: [], goals: [], journal: [], strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 }, totalExperiments: 0, bestResult: null },
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.relevantMemories).toEqual([]);
    });
  });

  describe('when brain has memories', () => {
    it('should return top 5 memories by importance', async () => {
      const memories: MemoryEntry[] = [
        { timestamp: 1, type: 'discovery', content: 'Low importance', importance: 0.1 },
        { timestamp: 2, type: 'discovery', content: 'High importance 1', importance: 0.9 },
        { timestamp: 3, type: 'experiment', content: 'Medium importance', importance: 0.5 },
        { timestamp: 4, type: 'discovery', content: 'High importance 2', importance: 0.95 },
        { timestamp: 5, type: 'failure', content: 'Low importance 2', importance: 0.2 },
        { timestamp: 6, type: 'experiment', content: 'Very high importance', importance: 0.99 },
      ];

      const state = makeState({
        brain: { memory: memories, goals: [], journal: [], strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 }, totalExperiments: 0, bestResult: null },
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.relevantMemories).toHaveLength(5);
      expect(result.relevantMemories?.[0].content).toBe('Very high importance');
      expect(result.relevantMemories?.[1].content).toBe('High importance 2');
      expect(result.relevantMemories?.[2].content).toBe('High importance 1');
      expect(result.relevantMemories?.[3].content).toBe('Medium importance');
      expect(result.relevantMemories?.[4].content).toBe('Low importance 2');
    });

    it('should return all memories if less than 5', async () => {
      const memories: MemoryEntry[] = [
        { timestamp: 1, type: 'discovery', content: 'Memory 1', importance: 0.8 },
        { timestamp: 2, type: 'discovery', content: 'Memory 2', importance: 0.7 },
      ];

      const state = makeState({
        brain: { memory: memories, goals: [], journal: [], strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 }, totalExperiments: 0, bestResult: null },
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.relevantMemories).toHaveLength(2);
    });
  });

  describe('when brain is missing', () => {
    it('should return empty array gracefully', async () => {
      const state = makeState({
        brain: null as any,
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.relevantMemories).toEqual([]);
    });
  });

  describe('when selected work order is missing', () => {
    it('should return empty array gracefully', async () => {
      const state = makeState({
        selectedWorkOrder: null,
      });

      const result = await node.execute(state);

      expect(result.relevantMemories).toEqual([]);
    });
  });

  describe('memory sorting', () => {
    it('should sort by importance descending', async () => {
      const memories: MemoryEntry[] = [
        { timestamp: 1, type: 'discovery', content: 'A', importance: 0.5 },
        { timestamp: 2, type: 'discovery', content: 'B', importance: 0.9 },
        { timestamp: 3, type: 'discovery', content: 'C', importance: 0.3 },
      ];

      const state = makeState({
        brain: { memory: memories, goals: [], journal: [], strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 }, totalExperiments: 0, bestResult: null },
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.relevantMemories?.map(m => m.content)).toEqual(['B', 'A', 'C']);
    });

    it('should handle memories with same importance', async () => {
      const memories: MemoryEntry[] = [
        { timestamp: 1, type: 'discovery', content: 'First', importance: 0.8 },
        { timestamp: 2, type: 'discovery', content: 'Second', importance: 0.8 },
      ];

      const state = makeState({
        brain: { memory: memories, goals: [], journal: [], strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 }, totalExperiments: 0, bestResult: null },
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.relevantMemories).toHaveLength(2);
    });
  });
});
