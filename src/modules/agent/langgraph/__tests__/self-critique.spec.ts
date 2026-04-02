/**
 * Unit tests for SelfCritiqueNode
 * Sprint B - Planning + Self-Critique
 */

import { jest } from '@jest/globals';
import { SelfCritiqueNode } from '../nodes/self-critique';
import type { AgentState, ResearchResult } from '../state';

// Mock logger to avoid console output during tests
jest.mock('../../../../utils/logger', () => ({
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('SelfCritiqueNode', () => {
  let node: SelfCritiqueNode;
  let mockLlmService: { generate: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    mockLlmService = {
      generate: jest.fn(),
    };
    node = new SelfCritiqueNode(mockLlmService as any);
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

  describe('for research work orders with passing scores', () => {
    it('should return passed=true when scores avg ≥ 7', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 8,
        completeness: 7,
        novelty: 8,
        actionability: 7,
        feedback: 'Good analysis with solid methodology',
        passed: true,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test summary', keyInsights: ['insight1'], proposal: 'Test proposal' } as ResearchResult,
        retryCount: 0,
      });

      const result = await node.execute(state);

      expect(result.selfCritiqueScore).toBe(7.5); // (8+7+8+7)/4
      expect(result.selfCritiquePassed).toBe(true);
      expect(result.selfCritiqueFeedback).toBe('Good analysis with solid methodology');
      expect(result.retryCount).toBe(0); // Should not increment on pass
    });

    it('should handle scores exactly at threshold (7.0)', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 7,
        completeness: 7,
        novelty: 7,
        actionability: 7,
        feedback: 'Acceptable but could be improved',
        passed: true,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test', keyInsights: [], proposal: 'Test' } as ResearchResult,
      });

      const result = await node.execute(state);

      expect(result.selfCritiqueScore).toBe(7.0);
      expect(result.selfCritiquePassed).toBe(true);
    });
  });

  describe('for research work orders with failing scores', () => {
    it('should return passed=false when scores avg < 7', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 6,
        completeness: 6,
        novelty: 5,
        actionability: 6,
        feedback: 'Analysis is too shallow, needs more depth',
        passed: false,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test summary', keyInsights: ['insight1'], proposal: 'Test proposal' } as ResearchResult,
        retryCount: 0,
      });

      const result = await node.execute(state);

      expect(result.selfCritiqueScore).toBe(5.75); // (6+6+5+6)/4
      expect(result.selfCritiquePassed).toBe(false);
      expect(result.selfCritiqueFeedback).toBe('Analysis is too shallow, needs more depth');
    });

    it('should increment retryCount correctly on failure', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 5,
        completeness: 5,
        novelty: 5,
        actionability: 5,
        feedback: 'Needs improvement',
        passed: false,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test', keyInsights: [], proposal: 'Test' } as ResearchResult,
        retryCount: 0,
      });

      const result = await node.execute(state);

      expect(result.retryCount).toBe(1);
    });

    it('should not exceed max retry count of 2', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 5,
        completeness: 5,
        novelty: 5,
        actionability: 5,
        feedback: 'Still needs work',
        passed: false,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test', keyInsights: [], proposal: 'Test' } as ResearchResult,
        retryCount: 2, // Already at max
      });

      const result = await node.execute(state);

      expect(result.retryCount).toBe(2);
    });
  });

  describe('for non-research work orders (fast path)', () => {
    it('should skip critique for training WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Training', type: 'TRAINING', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.selfCritiqueScore).toBe(0);
      expect(result.selfCritiquePassed).toBe(true);
      expect(result.selfCritiqueFeedback).toBe('');
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });

    it('should skip critique for inference WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Inference', type: 'CPU_INFERENCE', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.selfCritiquePassed).toBe(true);
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });

    it('should skip critique for diloco WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test DiLoCo', type: 'DILOCO_TRAINING', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.selfCritiquePassed).toBe(true);
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });
  });

  describe('when research result is missing', () => {
    it('should mark as failed and increment retry count', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: null,
        retryCount: 0,
      });

      const result = await node.execute(state);

      expect(result.selfCritiquePassed).toBe(false);
      expect(result.selfCritiqueFeedback).toBe('No research result available for critique');
      expect(result.retryCount).toBe(1);
      expect(mockLlmService.generate).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle invalid JSON from LLM gracefully', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce('invalid json');

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test', keyInsights: [], proposal: 'Test' } as ResearchResult,
        retryCount: 0,
      });

      const result = await node.execute(state);

      expect(result.selfCritiquePassed).toBe(false);
      expect(result.selfCritiqueFeedback).toContain('Failed to parse critique response');
      expect(result.retryCount).toBe(1);
    });

    it('should handle LLM error gracefully', async () => {
      (mockLlmService.generate as any).mockRejectedValueOnce(new Error('LLM timeout'));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test', keyInsights: [], proposal: 'Test' } as ResearchResult,
        retryCount: 0,
      });

      const result = await node.execute(state);

      expect(result.selfCritiquePassed).toBe(false);
      expect(result.selfCritiqueFeedback).toContain('Critique error');
      expect(result.retryCount).toBe(1);
    });

    it('should handle partial LLM response (missing fields)', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 8,
        // missing completeness, novelty, actionability, feedback, passed
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
        researchResult: { summary: 'Test', keyInsights: [], proposal: 'Test' } as ResearchResult,
        retryCount: 0,
      });

      const result = await node.execute(state);

      expect(result.selfCritiquePassed).toBe(false);
      expect(result.retryCount).toBe(1);
    });
  });

  describe('prompt building', () => {
    it('should include research details in the prompt', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 8, completeness: 8, novelty: 8, actionability: 8,
        feedback: 'Good', passed: true,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'My Research Paper', type: 'RESEARCH', abstract: 'Abstract text', reward: 100 } as any,
        researchResult: {
          summary: 'Research summary here',
          keyInsights: ['Insight 1', 'Insight 2'],
          proposal: 'Research proposal here',
        } as ResearchResult,
      });

      await node.execute(state);

      const prompt = (mockLlmService.generate as any).mock.calls[0][1];
      expect(prompt).toContain('My Research Paper');
      expect(prompt).toContain('Research summary here');
      expect(prompt).toContain('Insight 1, Insight 2');
      expect(prompt).toContain('Research proposal here');
    });

    it('should handle array keyInsights correctly', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 8, completeness: 8, novelty: 8, actionability: 8,
        feedback: 'Good', passed: true,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
        researchResult: {
          summary: 'Summary',
          keyInsights: ['insight1', 'insight2', 'insight3'],
          proposal: 'Proposal',
        } as ResearchResult,
      });

      await node.execute(state);

      const prompt = (mockLlmService.generate as any).mock.calls[0][1];
      expect(prompt).toContain('insight1, insight2, insight3');
    });

    it('should handle non-array keyInsights', async () => {
      (mockLlmService.generate as any).mockResolvedValueOnce(JSON.stringify({
        accuracy: 8, completeness: 8, novelty: 8, actionability: 8,
        feedback: 'Good', passed: true,
      }));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test', type: 'RESEARCH', abstract: '', reward: 100 } as any,
        researchResult: {
          summary: 'Summary',
          keyInsights: 'single insight' as any,
          proposal: 'Proposal',
        } as ResearchResult,
      });

      await node.execute(state);

      const prompt = (mockLlmService.generate as any).mock.calls[0][1];
      expect(prompt).toContain('single insight');
    });
  });
});
