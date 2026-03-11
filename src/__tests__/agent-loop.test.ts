import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { Experiment } from '../types.js';
import type { MutationProposal } from '../mutation-engine.js';
import type { TrainingResult } from '../trainer.js';

// Import the module under test
let agentLoop: typeof import('../agent-loop.js');

describe('Agent Loop', () => {
  const mockConfig = {
    coordinatorUrl: 'http://localhost:3001',
    peerId: 'test-peer-1',
    capabilities: ['cpu'],
    intervalMs: 100,
    datasetPath: './data/test.txt',
  };

  const mockMutation: MutationProposal = {
    model: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
    type: 'explore',
    baseExperimentId: null,
    reasoning: 'Test mutation for better learning rate',
    hyperparams: {
      learningRate: 0.001,
      batchSize: 32,
      hiddenDim: 128,
      numLayers: 4,
      numHeads: 4,
      activation: 'gelu',
      normalization: 'layernorm',
      initScheme: 'xavier',
      warmupSteps: 100,
      weightDecay: 0.01,
      maxTrainSeconds: 30,
    },
  };

  const mockTrainingResult: TrainingResult = {
    runNumber: 1,
    finalLoss: 2.5,
    valLoss: 2.8,
    improvementPercent: 10,
    durationMs: 5000,
    config: mockMutation.hyperparams,
    lossCurve: [3.5, 3.2, 3.0, 2.8],
    hardwareUsed: 'cpu',
  };

  // Store original fetch
  let originalFetch: typeof fetch;
  let mockFetchFn: jest.Mock;

  beforeEach(async () => {
    // Reset modules before each test
    jest.resetModules();
    
    // Create mock fetch with proper typing
    originalFetch = global.fetch;
    mockFetchFn = jest.fn<() => Promise<Response>>();
    global.fetch = mockFetchFn as unknown as typeof fetch;
    
    // Import fresh module
    agentLoop = await import('../agent-loop.js');
    agentLoop.resetAgentLoopState();
  });

  afterEach(() => {
    agentLoop.stopAgentLoop();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('State management', () => {
    it('should return initial state', () => {
      const state = agentLoop.getAgentLoopState();
      expect(state.iteration).toBe(0);
      expect(state.bestLoss).toBe(Infinity);
      expect(state.totalExperiments).toBe(0);
      expect(state.isRunning).toBe(false);
    });

    it('should reset state', () => {
      agentLoop.resetAgentLoopState();
      const state = agentLoop.getAgentLoopState();
      expect(state.iteration).toBe(0);
      expect(state.bestLoss).toBe(Infinity);
    });
  });

  describe('fetchTopExperiments', () => {
    it('should fetch and sort experiments by valLoss', async () => {
      const mockExperiments: Experiment[] = [
        { id: '1', model: 'test', hyperparams: {} as any, valLoss: 3.5, status: 'completed', createdAt: Date.now() },
        { id: '2', model: 'test', hyperparams: {} as any, valLoss: 2.5, status: 'completed', createdAt: Date.now() },
        { id: '3', model: 'test', hyperparams: {} as any, valLoss: 4.0, status: 'completed', createdAt: Date.now() },
      ];

      (mockFetchFn as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ experiments: mockExperiments }),
      });

      const result = await agentLoop.fetchTopExperiments('http://localhost:3001', 5);

      expect(result).toHaveLength(3);
      expect(result[0].valLoss).toBe(2.5);
      expect(result[1].valLoss).toBe(3.5);
      expect(result[2].valLoss).toBe(4.0);
    });

    it('should filter out experiments without valLoss', async () => {
      const mockExperiments: Experiment[] = [
        { id: '1', model: 'test', hyperparams: {} as any, valLoss: null as any, status: 'running', createdAt: Date.now() },
        { id: '2', model: 'test', hyperparams: {} as any, valLoss: 2.5, status: 'completed', createdAt: Date.now() },
      ];

      (mockFetchFn as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ experiments: mockExperiments }),
      });

      const result = await agentLoop.fetchTopExperiments('http://localhost:3001');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('should handle fetch errors gracefully', async () => {
      (mockFetchFn as any).mockRejectedValueOnce(new Error('Network error'));

      const result = await agentLoop.fetchTopExperiments('http://localhost:3001');

      expect(result).toEqual([]);
    });

    it('should handle non-ok response', async () => {
      (mockFetchFn as any).mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
      });

      const result = await agentLoop.fetchTopExperiments('http://localhost:3001');

      expect(result).toEqual([]);
    });

    it('should handle empty experiments array', async () => {
      (mockFetchFn as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ experiments: [] }),
      });

      const result = await agentLoop.fetchTopExperiments('http://localhost:3001');

      expect(result).toEqual([]);
    });
  });

  describe('createExperiment', () => {
    it('should create experiment successfully', async () => {
      (mockFetchFn as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ experiment: { id: 'exp-123' } }),
      });

      const id = await agentLoop.createExperiment('http://localhost:3001', mockMutation, 'peer-1', 0);

      expect(id).toBe('exp-123');
      expect(mockFetchFn).toHaveBeenCalledWith(
        'http://localhost:3001/experiments',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('micro-transformer-120k'),
        })
      );
    });

    it('should throw on error response', async () => {
      (mockFetchFn as any).mockResolvedValueOnce({
        ok: false,
        statusText: 'Bad Request',
      });

      await expect(agentLoop.createExperiment('http://localhost:3001', mockMutation, 'peer-1', 0))
        .rejects.toThrow('Failed to create experiment: Bad Request');
    });

    it('should throw on network error', async () => {
      (mockFetchFn as any).mockRejectedValueOnce(new Error('Network error'));

      await expect(agentLoop.createExperiment('http://localhost:3001', mockMutation, 'peer-1', 0))
        .rejects.toThrow('Failed to create experiment: Network error');
    });
  });

  describe('updateExperiment', () => {
    it('should update experiment successfully', async () => {
      (mockFetchFn as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await agentLoop.updateExperiment('http://localhost:3001', 'exp-123', mockTrainingResult);

      expect(mockFetchFn).toHaveBeenCalledWith(
        'http://localhost:3001/experiments/exp-123',
        expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('completed'),
        })
      );
    });

    it('should throw on error response', async () => {
      (mockFetchFn as any).mockResolvedValueOnce({
        ok: false,
        statusText: 'Not Found',
      });

      await expect(agentLoop.updateExperiment('http://localhost:3001', 'exp-123', mockTrainingResult))
        .rejects.toThrow('Failed to update experiment: Not Found');
    });
  });

  describe('postToFeed', () => {
    it('should log feed message without error', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agentLoop.postToFeed('http://localhost:3001', 'peer-1', mockMutation, mockTrainingResult, true);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IMPROVEMENT'));
      consoleSpy.mockRestore();
    });

    it('should log non-improvement message', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await agentLoop.postToFeed('http://localhost:3001', 'peer-1', mockMutation, mockTrainingResult, false);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Result'));
      consoleSpy.mockRestore();
    });
  });

  describe('stopAgentLoop', () => {
    it('should set isRunning to false', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      
      agentLoop.stopAgentLoop();
      
      const state = agentLoop.getAgentLoopState();
      expect(state.isRunning).toBe(false);
      
      consoleSpy.mockRestore();
    });
  });

  describe('_test exports', () => {
    it('should export test functions', () => {
      expect(agentLoop._test.fetchTopExperiments).toBe(agentLoop.fetchTopExperiments);
      expect(agentLoop._test.createExperiment).toBe(agentLoop.createExperiment);
      expect(agentLoop._test.updateExperiment).toBe(agentLoop.updateExperiment);
      expect(agentLoop._test.postToFeed).toBe(agentLoop.postToFeed);
    });
  });
});
