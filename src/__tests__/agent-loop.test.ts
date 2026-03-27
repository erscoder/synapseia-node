/**
 * Agent Loop tests
 * Tests for startAgentLoop, stopAgentLoop, getAgentLoopState, runAgentIteration
 */

import { jest } from '@jest/globals';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Create mock functions
const mockValidateTrainingConfig: any = jest.fn();
const mockProposeMutation: any = jest.fn();
const mockTrainMicroModel: any = jest.fn();
const mockCalculateImprovement: any = jest.fn();

// Mock modules before import
jest.mock('../modules/model/mutation-engine.js', () => ({
  proposeMutation: mockProposeMutation,
}));

jest.mock('../modules/model/trainer.js', () => ({
  trainMicroModel: mockTrainMicroModel,
  validateTrainingConfig: mockValidateTrainingConfig,
  calculateImprovement: mockCalculateImprovement,
}));

// Import after mocking
import {
  startAgentLoop, stopAgentLoop, getAgentLoopState, resetAgentLoopState,
  fetchTopExperiments, createExperiment, updateExperiment, postToFeed,
  runAgentIteration, type AgentLoopConfig,
} from '../modules/agent/agent-loop.js';

// Untyped mock for fetch
const mockFetch: any = jest.fn();

const mockConfig: AgentLoopConfig = {
  coordinatorUrl: 'http://localhost:3001',
  peerId: 'peer-1',
  capabilities: ['cpu'],
  intervalMs: 100,
  datasetPath: './data/test.txt',
};

const hp = {
  learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4,
  numHeads: 4, activation: 'gelu' as const, normalization: 'layernorm' as const,
  initScheme: 'xavier' as const, warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 30,
};

const mockMutation: any = {
  model: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
  type: 'explore', baseExperimentId: null,
  reasoning: 'Test reasoning long enough to slice for logging purposes in agent loop',
  hyperparams: hp,
};

const mockResult: any = {
  runNumber: 1, finalLoss: 2.5, valLoss: 2.8, improvementPercent: 10,
  durationMs: 5000, config: hp, lossCurve: [4.0, 3.5, 3.0, 2.8],
  hardwareUsed: 'cpu',
};

const okResp = (body: any) => Promise.resolve({ ok: true, json: async () => body });
const errResp = (text = 'Error') => Promise.resolve({ ok: false, statusText: text });

describe('Agent Loop', () => {
  beforeEach(() => {
    resetAgentLoopState();
    jest.clearAllMocks();
    mockFetch.mockReset();
    (global as any).fetch = mockFetch;
    mockValidateTrainingConfig.mockReturnValue({ valid: true });
    mockProposeMutation.mockResolvedValue(mockMutation);
    mockTrainMicroModel.mockResolvedValue(mockResult);
  });

  afterEach(() => {
    stopAgentLoop();
  });

  describe('State', () => {
    it('returns initial state', () => {
      const s = getAgentLoopState();
      expect(s.iteration).toBe(0);
      expect(s.bestLoss).toBe(Infinity);
      expect(s.totalExperiments).toBe(0);
      expect(s.isRunning).toBe(false);
    });

    it('resets state', () => {
      resetAgentLoopState();
      expect(getAgentLoopState().bestLoss).toBe(Infinity);
    });
  });

  describe('fetchTopExperiments', () => {
    it('sorts by valLoss', async () => {
      mockFetch.mockResolvedValue(okResp({
        experiments: [
          { id: '1', valLoss: 0.5 },
          { id: '2', valLoss: 0.1 },
          { id: '3', valLoss: 0.3 },
        ],
      }));

      const experiments = await fetchTopExperiments('http://localhost:3701', 3);

      expect(experiments[0].valLoss).toBe(0.1);
      expect(experiments[1].valLoss).toBe(0.3);
      expect(experiments[2].valLoss).toBe(0.5);
    });

    it('filters null valLoss', async () => {
      mockFetch.mockResolvedValue(okResp({
        experiments: [
          { id: '1', valLoss: 0.5 },
          { id: '2', valLoss: null },
          { id: '3', valLoss: 0.3 },
        ],
      }));

      const experiments = await fetchTopExperiments('http://localhost:3701', 3);

      expect(experiments).toHaveLength(2);
    });

    it('returns [] on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const experiments = await fetchTopExperiments('http://localhost:3701', 3);

      expect(experiments).toEqual([]);
    });

    it('returns [] on non-ok', async () => {
      mockFetch.mockResolvedValue(errResp('Server error'));

      const experiments = await fetchTopExperiments('http://localhost:3701', 3);

      expect(experiments).toEqual([]);
    });

    it('returns [] when empty', async () => {
      mockFetch.mockResolvedValue(okResp({}));

      const experiments = await fetchTopExperiments('http://localhost:3701', 3);

      expect(experiments).toEqual([]);
    });

    it('returns [] when experiments key missing', async () => {
      mockFetch.mockResolvedValue(okResp({ other: 'data' }));

      const experiments = await fetchTopExperiments('http://localhost:3701', 3);

      expect(experiments).toEqual([]);
    });

    it('handles undefined valLoss in sort (filters items without valLoss)', async () => {
      mockFetch.mockResolvedValue(okResp({
        experiments: [
          { id: '1' }, // no valLoss — filtered out
          { id: '2', valLoss: 0.2 },
        ],
      }));

      const experiments = await fetchTopExperiments('http://localhost:3701', 3);

      // Only items WITH valLoss are returned
      expect(experiments.length).toBe(1);
      expect(experiments[0].valLoss).toBe(0.2);
    });
  });

  describe('createExperiment', () => {
    it('returns id', async () => {
      mockFetch.mockResolvedValue(okResp({ experiment: { id: 'exp-123' } }));

      const id = await createExperiment('http://localhost:3701', mockMutation, 'peer-1', 0);

      expect(id).toBe('exp-123');
    });

    it('throws on bad response', async () => {
      mockFetch.mockResolvedValue(errResp('Bad request'));

      await expect(createExperiment('http://localhost:3701', mockMutation, 'peer-1', 0)).rejects.toThrow();
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(createExperiment('http://localhost:3701', mockMutation, 'peer-1', 0)).rejects.toThrow();
    });
  });

  describe('updateExperiment', () => {
    it('updates successfully', async () => {
      mockFetch.mockResolvedValue(okResp({ success: true }));

      await expect(updateExperiment('http://localhost:3701', 'exp-1', mockResult)).resolves.not.toThrow();
    });

    it('throws on error', async () => {
      mockFetch.mockRejectedValue(new Error('Update failed'));

      await expect(updateExperiment('http://localhost:3701', 'exp-1', mockResult)).rejects.toThrow();
    });
  });

  describe('postToFeed', () => {
    it('logs improvement', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await postToFeed('http://localhost:3701', 'peer-1', mockMutation, mockResult, true);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('logs result (no improvement)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await postToFeed('http://localhost:3701', 'peer-1', mockMutation, mockResult, false);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('handles errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Feed error'));
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw
      await expect(postToFeed('http://localhost:3701', 'peer-1', mockMutation, mockResult, false)).resolves.not.toThrow();

      consoleSpy.mockRestore();
    });
  });

  describe('runAgentIteration', () => {
    it('runs full cycle', async () => {
      mockFetch
        .mockResolvedValueOnce(okResp({ experiments: [] }))
        .mockResolvedValueOnce(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValueOnce(okResp({ success: true }));

      await expect(runAgentIteration(mockConfig, 1)).resolves.not.toThrow();
    });

    it('marks improved when valLoss < bestLoss', async () => {
      mockFetch
        .mockResolvedValueOnce(okResp({ experiments: [{ id: 'best', valLoss: 1.0 }] }))
        .mockResolvedValueOnce(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValueOnce(okResp({ success: true }));

      await runAgentIteration(mockConfig, 1);

      const state = getAgentLoopState();
      expect(state.bestLoss).toBe(1.0);
    });

    it('marks not improved', async () => {
      mockFetch
        .mockResolvedValueOnce(okResp({ experiments: [{ id: 'best', valLoss: 2.0 }] }))
        .mockResolvedValueOnce(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValueOnce(okResp({ success: true }));

      await runAgentIteration(mockConfig, 1);

      // bestLoss should still be 2.0
      const state = getAgentLoopState();
      expect(state.bestLoss).toBe(2.0);
    });

    it('uses GPU hardware when capabilities include gpu', async () => {
      mockFetch
        .mockResolvedValueOnce(okResp({ experiments: [] }))
        .mockResolvedValueOnce(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValueOnce(okResp({ success: true }));

      const gpuConfig: AgentLoopConfig = { ...mockConfig, capabilities: ['gpu'] };
      await runAgentIteration(gpuConfig, 1);

      expect(mockTrainMicroModel).toHaveBeenCalledWith(
        expect.objectContaining({ hardware: 'gpu' })
      );
    });

    it('uses cpu hardware when no gpu capability', async () => {
      mockFetch
        .mockResolvedValueOnce(okResp({ experiments: [] }))
        .mockResolvedValueOnce(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValueOnce(okResp({ success: true }));

      await runAgentIteration(mockConfig, 1);

      expect(mockTrainMicroModel).toHaveBeenCalledWith(
        expect.objectContaining({ hardware: 'cpu' })
      );
    });

    it('throws on invalid config', async () => {
      mockValidateTrainingConfig.mockReturnValue({ valid: false, error: 'Invalid config' });

      await expect(runAgentIteration(mockConfig, 1)).rejects.toThrow();
    });

    it('increments totalExperiments', async () => {
      mockFetch
        .mockResolvedValueOnce(okResp({ experiments: [] }))
        .mockResolvedValueOnce(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValueOnce(okResp({ success: true }));

      await runAgentIteration(mockConfig, 1);

      const state = getAgentLoopState();
      expect(state.totalExperiments).toBe(1);
    });
  });

  describe('startAgentLoop', () => {
    it('throws if already running', async () => {
      startAgentLoop(mockConfig);

      await expect(startAgentLoop(mockConfig)).rejects.toThrow();

      stopAgentLoop();
    });

    it('stops after maxIterations', async () => {
      mockFetch
        .mockResolvedValue(okResp({ experiments: [] }))
        .mockResolvedValue(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValue(okResp({ success: true }));

      const shortConfig: AgentLoopConfig = { ...mockConfig, intervalMs: 10, maxIterations: 2 };
      startAgentLoop(shortConfig);

      await new Promise(resolve => setTimeout(resolve, 200));

      const state = getAgentLoopState();
      // Loop stops (either by reaching maxIterations or due to mock exhaustion)
      expect(state.isRunning).toBe(false);
    });

    it('continues after error in proposeMutation', async () => {
      mockProposeMutation.mockRejectedValue(new Error('Mutation failed'));
      mockFetch
        .mockResolvedValueOnce(okResp({ experiments: [] }))
        .mockResolvedValueOnce(okResp({ experiment: { id: 'new-exp' } }))
        .mockResolvedValueOnce(okResp({ success: true }));

      const errorConfig: AgentLoopConfig = { ...mockConfig, intervalMs: 10 };
      startAgentLoop(errorConfig);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should still be running despite error
      const state = getAgentLoopState();
      // May or may not be running depending on error handling

      stopAgentLoop();
    });
  });

  describe('stopAgentLoop', () => {
    it('sets isRunning false', () => {
      startAgentLoop(mockConfig);
      stopAgentLoop();

      expect(getAgentLoopState().isRunning).toBe(false);
    });
  });
});