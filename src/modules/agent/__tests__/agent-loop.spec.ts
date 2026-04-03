import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AgentLoopHelper, type AgentLoopConfig, type AgentLoopState } from '../agent-loop';

// ── mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../model/mutation-engine', () => ({
  proposeMutation: jest.fn().mockResolvedValue({
    type: 'lr_change',
    reasoning: 'try lower lr',
    hyperparams: { learningRate: 0.001 },
  } as never),
}));

jest.mock('../../model/trainer', () => ({
  trainMicroModel: jest.fn().mockResolvedValue({
    valLoss: 0.3,
    finalLoss: 0.28,
    durationMs: 100,
    lossCurve: [0.5, 0.4, 0.3],
    hardwareUsed: 'cpu',
    config: {},
  } as never),
  validateTrainingConfig: jest.fn().mockReturnValue({ valid: true } as never),
}));

// mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch as typeof fetch;

const BASE_URL = 'http://localhost:3001';

const makeConfig = (overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig => ({
  coordinatorUrl: BASE_URL,
  peerId: 'peer-test',
  capabilities: ['cpu'],
  intervalMs: 100,
  datasetPath: '/tmp/dataset.txt',
  ...overrides,
});

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body), statusText: 'OK' } as Response);

const failResponse = (status = 500, text = 'Internal Server Error') =>
  Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve(text), statusText: text, status } as Response);

// ── AgentLoopHelper ───────────────────────────────────────────────────────────

describe('AgentLoopHelper', () => {
  let helper: AgentLoopHelper;

  beforeEach(() => {
    helper = new AgentLoopHelper();
    mockFetch.mockReset();
  });

  // ── state ─────────────────────────────────────────────────────────────────

  describe('getAgentLoopState()', () => {
    it('returns default state on init', () => {
      const state = helper.getAgentLoopState();
      expect(state.isRunning).toBe(false);
      expect(state.iteration).toBe(0);
      expect(state.bestLoss).toBe(Infinity);
      expect(state.totalExperiments).toBe(0);
    });

    it('returns a copy, not the internal reference', () => {
      const s1 = helper.getAgentLoopState();
      s1.iteration = 999;
      expect(helper.getAgentLoopState().iteration).toBe(0);
    });
  });

  describe('resetAgentLoopState()', () => {
    it('resets all fields', () => {
      helper['state'] = { iteration: 5, bestLoss: 0.1, totalExperiments: 5, isRunning: true };
      helper.resetAgentLoopState();
      const s = helper.getAgentLoopState();
      expect(s.iteration).toBe(0);
      expect(s.bestLoss).toBe(Infinity);
      expect(s.totalExperiments).toBe(0);
      expect(s.isRunning).toBe(false);
    });
  });

  // ── stopAgentLoop ─────────────────────────────────────────────────────────

  describe('stopAgentLoop()', () => {
    it('sets isRunning to false', () => {
      helper['state'].isRunning = true;
      helper.stopAgentLoop();
      expect(helper.getAgentLoopState().isRunning).toBe(false);
    });
  });

  // ── fetchTopExperiments ───────────────────────────────────────────────────

  describe('fetchTopExperiments()', () => {
    it('returns sorted experiments from coordinator', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        experiments: [
          { id: 'a', valLoss: 0.5, status: 'completed' },
          { id: 'b', valLoss: 0.2, status: 'completed' },
          { id: 'c', valLoss: 0.8, status: 'completed' },
        ],
      }) as never);
      const result = await helper.fetchTopExperiments(BASE_URL, 5);
      expect(result[0].valLoss).toBe(0.2);
      expect(result[1].valLoss).toBe(0.5);
    });

    it('returns empty array on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(failResponse() as never);
      const result = await helper.fetchTopExperiments(BASE_URL);
      expect(result).toEqual([]);
    });

    it('returns empty array on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down') as never);
      const result = await helper.fetchTopExperiments(BASE_URL);
      expect(result).toEqual([]);
    });

    it('respects limit param', async () => {
      const exps = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, valLoss: i * 0.1, status: 'completed' }));
      mockFetch.mockResolvedValueOnce(okJson({ experiments: exps }) as never);
      const result = await helper.fetchTopExperiments(BASE_URL, 3);
      expect(result).toHaveLength(3);
    });

    it('filters out experiments with null valLoss', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        experiments: [
          { id: 'a', valLoss: null, status: 'completed' },
          { id: 'b', valLoss: 0.4, status: 'completed' },
        ],
      }) as never);
      const result = await helper.fetchTopExperiments(BASE_URL);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('b');
    });
  });

  // ── createExperiment ──────────────────────────────────────────────────────

  describe('createExperiment()', () => {
    const proposal = { type: 'lr_change', reasoning: 'try', hyperparams: { learningRate: 0.001 } };

    it('returns experiment id on success', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ experiment: { id: 'exp-abc' } }) as never);
      const id = await helper.createExperiment(BASE_URL, proposal as any, 'peer-1', 1);
      expect(id).toBe('exp-abc');
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(failResponse() as never);
      await expect(helper.createExperiment(BASE_URL, proposal as any, 'peer-1', 1)).rejects.toThrow();
    });
  });

  // ── updateExperiment ──────────────────────────────────────────────────────

  describe('updateExperiment()', () => {
    const trainingResult = { valLoss: 0.3, finalLoss: 0.28, durationMs: 100, lossCurve: [], hardwareUsed: 'cpu', config: {} };

    it('resolves on success', async () => {
      mockFetch.mockResolvedValueOnce(okJson({}) as never);
      await expect(helper.updateExperiment(BASE_URL, 'exp-1', trainingResult as any)).resolves.toBeUndefined();
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(failResponse() as never);
      await expect(helper.updateExperiment(BASE_URL, 'exp-1', trainingResult as any)).rejects.toThrow();
    });
  });

  // ── runAgentIteration ─────────────────────────────────────────────────────

  describe('runAgentIteration()', () => {
    it('returns iteration result with improved flag', async () => {
      // fetchTopExperiments
      mockFetch.mockResolvedValueOnce(okJson({ experiments: [] }) as never);
      // createExperiment
      mockFetch.mockResolvedValueOnce(okJson({ experiment: { id: 'exp-1' } }) as never);
      // updateExperiment
      mockFetch.mockResolvedValueOnce(okJson({}) as never);

      const result = await helper.runAgentIteration(makeConfig(), 1);
      expect(result.iteration).toBe(1);
      expect(result.experimentId).toBe('exp-1');
      expect(typeof result.improved).toBe('boolean');
      expect(result.trainingResult).toBeDefined();
    });

    it('updates totalExperiments', async () => {
      mockFetch
        .mockResolvedValueOnce(okJson({ experiments: [] }) as never)
        .mockResolvedValueOnce(okJson({ experiment: { id: 'x' } }) as never)
        .mockResolvedValueOnce(okJson({}) as never);

      await helper.runAgentIteration(makeConfig(), 1);
      expect(helper.getAgentLoopState().totalExperiments).toBe(1);
    });

    it('updates bestLoss when improved', async () => {
      helper['state'].bestLoss = Infinity;

      mockFetch
        .mockResolvedValueOnce(okJson({ experiments: [] }) as never)
        .mockResolvedValueOnce(okJson({ experiment: { id: 'y' } }) as never)
        .mockResolvedValueOnce(okJson({}) as never);

      await helper.runAgentIteration(makeConfig(), 1);
      // trainMicroModel returns valLoss 0.3 (mocked above)
      expect(helper.getAgentLoopState().bestLoss).toBeLessThan(Infinity);
    });

    it('throws when validateTrainingConfig fails', async () => {
      const { validateTrainingConfig } = await import('../../model/trainer');
      (validateTrainingConfig as jest.MockedFunction<typeof validateTrainingConfig>).mockReturnValueOnce({ valid: false, error: 'bad config' } as any);

      mockFetch.mockResolvedValueOnce(okJson({ experiments: [] }) as never);

      await expect(helper.runAgentIteration(makeConfig(), 1)).rejects.toThrow('Invalid training config');
    });
  });

  // ── startAgentLoop ────────────────────────────────────────────────────────

  describe('startAgentLoop()', () => {
    it('throws if already running', async () => {
      helper['state'].isRunning = true;
      await expect(helper.startAgentLoop(makeConfig())).rejects.toThrow('already running');
    });

    it('runs exactly maxIterations and stops', async () => {
      // Each iteration: fetchTopExperiments + createExperiment + updateExperiment
      const mockIter = () => {
        mockFetch
          .mockResolvedValueOnce(okJson({ experiments: [] }) as never)
          .mockResolvedValueOnce(okJson({ experiment: { id: `e-${Date.now()}` } }) as never)
          .mockResolvedValueOnce(okJson({}) as never);
      };
      mockIter(); mockIter(); // 2 iterations

      await helper.startAgentLoop(makeConfig({ maxIterations: 2, intervalMs: 0 }));
      expect(helper.getAgentLoopState().isRunning).toBe(false);
      expect(helper.getAgentLoopState().totalExperiments).toBe(2);
    });
  });
});
