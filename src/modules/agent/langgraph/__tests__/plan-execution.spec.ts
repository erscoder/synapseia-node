/**
 * Unit tests for PlanExecutionNode
 * Sprint B - Planning + Self-Critique
 */

import { jest } from '@jest/globals';
import { PlanExecutionNode } from '../nodes/plan-execution';
import type { AgentState, ExecutionStep } from '../state';
import { DEFAULT_EXECUTION_PLAN } from '../prompts/plan';

// Mock logger to avoid console output during tests
jest.mock('../../../../utils/logger', () => ({
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('PlanExecutionNode', () => {
  let node: PlanExecutionNode;
  let mockLlmService: { generate: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    mockLlmService = {
      generate: jest.fn(),
    };
    node = new PlanExecutionNode(mockLlmService as any);
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
        llmConfig: { timeoutMs: 30000 },
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

  describe('for research work orders', () => {
    it('should return valid ExecutionStep[] from LLM response', async () => {
      const validPlan: ExecutionStep[] = [
        { id: '1', action: 'fetch_context', description: 'Search reference corpus' },
        { id: '2', action: 'analyze_paper', description: 'Extract key findings' },
        { id: '3', action: 'generate_hypothesis', description: 'Formulate hypothesis' },
      ];
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify(validPlan));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(validPlan);
      expect(result.currentStepIndex).toBe(0);
    });

    it('should handle invalid JSON from LLM (fallback to default plan)', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce('invalid json response');

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(DEFAULT_EXECUTION_PLAN);
      expect(result.currentStepIndex).toBe(0);
    });

    it('should handle LLM error gracefully', async () => {
      (mockLlmService.generate as any).mockRejectedValueOnce(new Error('LLM timeout'));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(DEFAULT_EXECUTION_PLAN);
      expect(result.currentStepIndex).toBe(0);
    });

    it('should limit plan to 5 steps', async () => {
      const longPlan: ExecutionStep[] = Array.from({ length: 10 }, (_, i) => ({
        id: String(i + 1),
        action: 'fetch_context',
        description: `Step ${i + 1}`,
      }));
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify(longPlan));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toHaveLength(5);
    });

    it('should filter out invalid actions', async () => {
      const planWithInvalid = [
        { id: '1', action: 'fetch_context', description: 'Valid step' },
        { id: '2', action: 'invalid_action', description: 'Invalid action' },
        { id: '3', action: 'analyze_paper', description: 'Another valid step' },
      ];
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify(planWithInvalid));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toHaveLength(2);
      expect(result.executionPlan?.[0].action).toBe('fetch_context');
      expect(result.executionPlan?.[1].action).toBe('analyze_paper');
    });

    it('should format memories for the prompt', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify(DEFAULT_EXECUTION_PLAN));

      const state = makeState({
        selectedWorkOrder: { 
          id: 'wo-1', 
          title: 'Test Research', 
          type: 'RESEARCH', 
          description: JSON.stringify({ title: 'Test Research', abstract: 'Test abstract' }),
          reward: 100 
        } as any,
        relevantMemories: [
          { timestamp: 1, type: 'discovery', content: 'Memory 1', importance: 0.8 },
          { timestamp: 2, type: 'discovery', content: 'Memory 2', importance: 0.9 },
        ],
      });

      await node.execute(state);

      const prompt = (mockLlmService.generate as any).mock.calls[0][1];
      expect(prompt).toContain('Memory 1');
      expect(prompt).toContain('Memory 2');
      expect(prompt).toContain('Test Research');
      expect(prompt).toContain('Test abstract');
    });

    it('should handle empty memories', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify(DEFAULT_EXECUTION_PLAN));

      const state = makeState({
        selectedWorkOrder: { 
          id: 'wo-1', 
          title: 'Test Research', 
          type: 'RESEARCH', 
          description: JSON.stringify({ title: 'Test Research', abstract: 'Test abstract' }),
          reward: 100 
        } as any,
        relevantMemories: [],
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(DEFAULT_EXECUTION_PLAN);
      const prompt = (mockLlmService.generate as any).mock.calls[0][1];
      expect(prompt).toContain('None');
    });
  });

  describe('for non-research work orders (fast path)', () => {
    it('should skip planning for training WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Training', type: 'TRAINING', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });

    it('should skip planning for inference WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Inference', type: 'CPU_INFERENCE', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });

    it('should skip planning for diloco WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test DiLoCo', type: 'DILOCO_TRAINING', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });
  });

  describe('when selected work order is null', () => {
    it('should return empty plan', async () => {
      const state = makeState({
        selectedWorkOrder: null,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });
  });
});
