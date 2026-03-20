import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../modules/model/mutation-engine.js', () => ({ proposeMutation: jest.fn() }));
jest.mock('../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(),
  calculateImprovement: jest.fn(),
}));

import { proposeMutation } from '../modules/model/mutation-engine.js';
import { trainMicroModel, validateTrainingConfig } from '../modules/model/trainer.js';
import {
  startAgentLoop, stopAgentLoop, getAgentLoopState, resetAgentLoopState,
  fetchTopExperiments, createExperiment, updateExperiment, postToFeed,
  runAgentIteration, _test, type AgentLoopConfig,
} from '../modules/agent/agent-loop.js';

// Untyped mock — avoids 'never' inference issues
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
    (global as any).fetch = mockFetch;
    (validateTrainingConfig as any).mockReturnValue({ valid: true });
    (proposeMutation as any).mockResolvedValue(mockMutation);
    (trainMicroModel as any).mockResolvedValue(mockResult);
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
      mockFetch.mockReturnValue(okResp({ experiments: [
        { id: '1', valLoss: 3.5 }, { id: '2', valLoss: 2.5 }, { id: '3', valLoss: 4.0 },
      ]}));
      const r = await fetchTopExperiments('http://localhost:3001', 5);
      expect(r[0].valLoss).toBe(2.5);
      expect(r[2].valLoss).toBe(4.0);
    });

    it('filters null valLoss', async () => {
      mockFetch.mockReturnValue(okResp({ experiments: [{ id: '1', valLoss: null }, { id: '2', valLoss: 2.5 }] }));
      expect(await fetchTopExperiments('http://localhost:3001')).toHaveLength(1);
    });

    it('returns [] on network error', async () => {
      mockFetch.mockReturnValue(Promise.reject(new Error('net')));
      expect(await fetchTopExperiments('http://localhost:3001')).toEqual([]);
    });

    it('returns [] on non-ok', async () => {
      mockFetch.mockReturnValue(errResp());
      expect(await fetchTopExperiments('http://localhost:3001')).toEqual([]);
    });

    it('returns [] when empty', async () => {
      mockFetch.mockReturnValue(okResp({ experiments: [] }));
      expect(await fetchTopExperiments('http://localhost:3001')).toEqual([]);
    });

    it('returns [] when experiments key missing', async () => {
      mockFetch.mockReturnValue(okResp({}));  // no experiments key → undefined || []
      expect(await fetchTopExperiments('http://localhost:3001')).toEqual([]);
    });

    it('handles undefined valLoss in sort (uses Infinity fallback)', async () => {
      mockFetch.mockReturnValue(okResp({ experiments: [
        { id: '1', valLoss: undefined }, { id: '2', valLoss: 2.5 },
      ]}));
      const r = await fetchTopExperiments('http://localhost:3001');
      // undefined passes the filter (only null/undefined filtered), Infinity fallback in sort
      expect(r.length).toBeGreaterThan(0);
    });
  });

  describe('createExperiment', () => {
    it('returns id', async () => {
      mockFetch.mockReturnValue(okResp({ experiment: { id: 'exp-1' } }));
      expect(await createExperiment('http://localhost:3001', mockMutation, 'p', 0)).toBe('exp-1');
    });

    it('throws on bad response', async () => {
      mockFetch.mockReturnValue(errResp('Bad Request'));
      await expect(createExperiment('http://localhost:3001', mockMutation, 'p', 0)).rejects.toThrow('Bad Request');
    });

    it('throws on network error', async () => {
      mockFetch.mockReturnValue(Promise.reject(new Error('net')));
      await expect(createExperiment('http://localhost:3001', mockMutation, 'p', 0)).rejects.toThrow('net');
    });
  });

  describe('updateExperiment', () => {
    it('updates successfully', async () => {
      mockFetch.mockReturnValue(okResp({}));
      await updateExperiment('http://localhost:3001', 'exp-1', mockResult);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3001/experiments/exp-1', expect.objectContaining({ method: 'PATCH' }));
    });

    it('throws on error', async () => {
      mockFetch.mockReturnValue(errResp('Not Found'));
      await expect(updateExperiment('http://localhost:3001', 'x', mockResult)).rejects.toThrow('Not Found');
    });
  });

  describe('postToFeed', () => {
    it('logs improvement', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await postToFeed('', '', mockMutation, mockResult, true);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('IMPROVEMENT'));
      spy.mockRestore();
    });

    it('logs result', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await postToFeed('', '', mockMutation, mockResult, false);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Result'));
      spy.mockRestore();
    });

    it('handles errors gracefully', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { throw new Error('log failed'); });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await postToFeed('', '', mockMutation, mockResult, true);
      expect(warnSpy).toHaveBeenCalledWith('Failed to post to feed:', expect.any(String));
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('runAgentIteration', () => {
    const setup3 = () => mockFetch
      .mockReturnValueOnce(okResp({ experiments: [] }))
      .mockReturnValueOnce(okResp({ experiment: { id: 'exp-new' } }))
      .mockReturnValueOnce(okResp({}));

    it('runs full cycle', async () => {
      setup3();
      const r = await runAgentIteration(mockConfig, 1);
      expect(r.iteration).toBe(1);
      expect(r.experimentId).toBe('exp-new');
      expect(r.improved).toBe(true);
    });

    it('marks improved when valLoss < bestLoss', async () => {
      mockFetch
        .mockReturnValueOnce(okResp({ experiments: [{ id: '1', valLoss: 5.0 }] }))
        .mockReturnValueOnce(okResp({ experiment: { id: 'e1' } }))
        .mockReturnValueOnce(okResp({}));
      const r = await runAgentIteration(mockConfig, 1);
      expect(r.improved).toBe(true);
    });

    it('marks not improved', async () => {
      mockFetch
        .mockReturnValueOnce(okResp({ experiments: [{ id: '1', valLoss: 2.0 }] }))
        .mockReturnValueOnce(okResp({ experiment: { id: 'e1' } }))
        .mockReturnValueOnce(okResp({}));
      const r = await runAgentIteration(mockConfig, 1);
      expect(r.improved).toBe(false);
    });

    it('uses GPU hardware', async () => {
      setup3();
      await runAgentIteration({ ...mockConfig, capabilities: ['cpu', 'gpu'] }, 1);
      expect(trainMicroModel).toHaveBeenCalledWith(expect.objectContaining({ hardware: 'gpu' }));
    });

    it('uses tier 2 for GPU', async () => {
      setup3();
      await runAgentIteration({ ...mockConfig, capabilities: ['gpu'] }, 1);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: expect.stringContaining('"tier":2') }));
    });

    it('throws on invalid config', async () => {
      mockFetch.mockReturnValueOnce(okResp({ experiments: [] }));
      (validateTrainingConfig as any).mockReturnValueOnce({ valid: false, error: 'bad lr' });
      await expect(runAgentIteration(mockConfig, 1)).rejects.toThrow('bad lr');
    });

    it('increments totalExperiments', async () => {
      setup3();
      await runAgentIteration(mockConfig, 1);
      expect(getAgentLoopState().totalExperiments).toBe(1);
    });
  });

  describe('startAgentLoop', () => {
    it('throws if already running', async () => {
      // First fetch never resolves → loop stays stuck waiting
      mockFetch.mockReturnValue(new Promise(() => {}));
      // Start loop but don't await — it hangs on fetch
      startAgentLoop({ ...mockConfig, intervalMs: 60000 }).catch(() => {});
      // Give the loop time to set isRunning = true
      await new Promise(r => setTimeout(r, 20));
      // Second call should throw synchronously
      await expect(startAgentLoop(mockConfig)).rejects.toThrow('already running');
      stopAgentLoop();
    }, 10000);

    it('stops after maxIterations', async () => {
      mockFetch
        .mockReturnValueOnce(okResp({ experiments: [] }))
        .mockReturnValueOnce(okResp({ experiment: { id: 'e1' } }))
        .mockReturnValueOnce(okResp({}));
      await startAgentLoop({ ...mockConfig, intervalMs: 10, maxIterations: 1 });
      const s = getAgentLoopState();
      expect(s.iteration).toBe(1);
      expect(s.isRunning).toBe(false);
    });

    it('continues after error in proposeMutation', async () => {
      // Iter 1: experiments ok, but proposeMutation throws → caught, loop continues
      // Iter 2: full success
      mockFetch
        .mockReturnValueOnce(okResp({ experiments: [] }))  // iter 1 experiments
        .mockReturnValueOnce(okResp({ experiments: [] }))  // iter 2 experiments
        .mockReturnValueOnce(okResp({ experiment: { id: 'e2' } }))  // iter 2 create
        .mockReturnValueOnce(okResp({}));  // iter 2 update
      (proposeMutation as any)
        .mockRejectedValueOnce(new Error('LLM fail'))  // iter 1 fails
        .mockResolvedValue(mockMutation);  // iter 2 ok
      await startAgentLoop({ ...mockConfig, intervalMs: 10, maxIterations: 2 });
      expect(getAgentLoopState().iteration).toBe(2);
    });
  });

  describe('stopAgentLoop', () => {
    it('sets isRunning false', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      stopAgentLoop();
      expect(getAgentLoopState().isRunning).toBe(false);
      spy.mockRestore();
    });
  });

  describe('_test exports', () => {
    it('exports helpers', () => {
      expect(_test.fetchTopExperiments).toBe(fetchTopExperiments);
      expect(_test.createExperiment).toBe(createExperiment);
      expect(_test.updateExperiment).toBe(updateExperiment);
      expect(_test.postToFeed).toBe(postToFeed);
      expect(_test.runAgentIteration).toBe(runAgentIteration);
    });
  });
});
