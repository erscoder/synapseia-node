import { jest } from '@jest/globals';
/**
 * Sprint A Tests — Node side
 * Covers: A5 (isTrainingWorkOrder + routing), A6 (canTrain), A7 (submit results)
 */

import {
  isTrainingWorkOrder,
  isResearchWorkOrder,
  fetchTopExperiments,
  submitTrainingExperiment,
  submitTrainingToExperiments,
  executeTrainingWorkOrder,
  type WorkOrder,
  type TrainingWorkOrderPayload,
} from '../modules/agent/work-order-agent.js';
import { HardwareHelper, canTrain, buildCapabilities } from '../modules/hardware/hardware.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrainingWO(overrides: Partial<WorkOrder> = {}): WorkOrder {
  const payload: TrainingWorkOrderPayload = {
    domain: 'ai',
    datasetId: 'synthetic://text8',
    maxTrainSeconds: 30,
    currentBestLoss: 3.5,
  };
  return {
    id: 'wo_training_1',
    title: 'Train micro-transformer: ai',
    description: JSON.stringify(payload),
    requiredCapabilities: ['training'],
    rewardAmount: '10.000000000',
    status: 'PENDING',
    creatorAddress: 'coordinator_system',
    createdAt: Math.floor(Date.now() / 1000),
    type: 'TRAINING',
    ...overrides,
  };
}

function makeResearchWO(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo_research_1',
    title: 'Research paper',
    description: JSON.stringify({ title: 'Some Paper', abstract: 'An abstract.' }),
    requiredCapabilities: [],
    rewardAmount: '5.000000000',
    status: 'PENDING',
    creatorAddress: 'creator',
    createdAt: Math.floor(Date.now() / 1000),
    type: 'RESEARCH',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A5: isTrainingWorkOrder
// ---------------------------------------------------------------------------

describe('A5 — isTrainingWorkOrder', () => {
  it('should return true for WO with type=TRAINING', () => {
    expect(isTrainingWorkOrder(makeTrainingWO({ type: 'TRAINING' }))).toBe(true);
  });

  it('should return true when description has training payload fields', () => {
    const wo = makeTrainingWO({ type: undefined as unknown as 'TRAINING' });
    expect(isTrainingWorkOrder(wo)).toBe(true);
  });

  it('should return false for RESEARCH work order', () => {
    expect(isTrainingWorkOrder(makeResearchWO())).toBe(false);
  });

  it('should return false for invalid JSON description', () => {
    const wo = makeTrainingWO({ description: 'not json', type: undefined as unknown as 'TRAINING' });
    expect(isTrainingWorkOrder(wo)).toBe(false);
  });

  it('should return false for JSON without training fields', () => {
    const wo = makeTrainingWO({
      description: JSON.stringify({ someField: 'value' }),
      type: undefined as unknown as 'TRAINING',
    });
    expect(isTrainingWorkOrder(wo)).toBe(false);
  });

  it('should not mistake RESEARCH WOs as TRAINING and vice versa', () => {
    expect(isTrainingWorkOrder(makeResearchWO())).toBe(false);
    expect(isResearchWorkOrder(makeTrainingWO())).toBe(false);
  });

  it('should return true when type=TRAINING even if description is invalid JSON', () => {
    const wo = makeTrainingWO({ type: 'TRAINING', description: 'not json' });
    expect(isTrainingWorkOrder(wo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A5: fetchTopExperiments
// ---------------------------------------------------------------------------

describe('A5 — fetchTopExperiments', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return empty array when fetch throws', async () => {
    global.fetch = (jest.fn() as any).mockRejectedValue(new Error('network error'));
    const result = await fetchTopExperiments('http://localhost:3000');
    expect(result).toEqual([]);
  });

  it('should return empty array when response is not ok', async () => {
    global.fetch = (jest.fn() as any).mockResolvedValue({ ok: false, json: async () => ({}) });
    const result = await fetchTopExperiments('http://localhost:3000');
    expect(result).toEqual([]);
  });

  it('should map leaderboard entries to Experiment shape', async () => {
    global.fetch = (jest.fn() as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [
          { config: { id: 'cfg_1', learningRate: 0.001 }, bestScore: 2.5 },
          { config: { id: 'cfg_2', learningRate: 0.0005 }, bestScore: 2.8 },
        ],
      }),
    });

    const result = await fetchTopExperiments('http://localhost:3000');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('cfg_1');
    expect(result[0].valLoss).toBe(2.5);
    expect(result[0].status).toBe('completed');
  });

  it('should return at most 5 entries', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      config: { id: `cfg_${i}` },
      bestScore: i,
    }));
    global.fetch = (jest.fn() as any).mockResolvedValue({
      ok: true,
      json: async () => ({ entries }),
    });

    const result = await fetchTopExperiments('http://localhost:3000');
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('should handle missing entries field gracefully', async () => {
    global.fetch = (jest.fn() as any).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const result = await fetchTopExperiments('http://localhost:3000');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A7: submitTrainingExperiment
// ---------------------------------------------------------------------------

describe('A7 — submitTrainingExperiment', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should POST to /hyperparams/experiments', async () => {
    const mockFetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = mockFetch as any;

    await submitTrainingExperiment(
      'http://localhost:3000',
      'peer_1',
      { learningRate: 0.001, batchSize: 32 },
      2.5,
      30000,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/hyperparams/experiments',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.peerId).toBe('peer_1');
    expect(body.qualityScore).toBeGreaterThanOrEqual(0);
    expect(body.qualityScore).toBeLessThanOrEqual(10);
    expect(body.latencyMs).toBe(30000);
  });

  it('should not throw if fetch fails', async () => {
    global.fetch = (jest.fn() as any).mockRejectedValue(new Error('network error'));
    await expect(
      submitTrainingExperiment('http://localhost:3000', 'p', {}, 2.5, 1000),
    ).resolves.not.toThrow();
  });

  it('should compute higher qualityScore for lower valLoss', async () => {
    const mockFetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = mockFetch as any;

    await submitTrainingExperiment('http://x', 'p', {}, 0.1, 1000);
    const bodyLow = JSON.parse(mockFetch.mock.calls[0][1].body as string);

    mockFetch.mockClear();

    await submitTrainingExperiment('http://x', 'p', {}, 5.0, 1000);
    const bodyHigh = JSON.parse(mockFetch.mock.calls[0][1].body as string);

    expect(bodyLow.qualityScore).toBeGreaterThan(bodyHigh.qualityScore);
  });
});

// ---------------------------------------------------------------------------
// A7: submitTrainingToExperiments
// ---------------------------------------------------------------------------

describe('A7 — submitTrainingToExperiments', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const payload: TrainingWorkOrderPayload = {
    domain: 'ai',
    datasetId: 'synthetic://text8',
    maxTrainSeconds: 120,
    currentBestLoss: 3.0,
  };

  it('should POST to /experiments', async () => {
    const mockFetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = mockFetch as any;

    await submitTrainingToExperiments('http://localhost:3000', 'peer_1', payload, 2.4, 2.3, 45000);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/experiments',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.peerId).toBe('peer_1');
    expect(body.domain).toBe('ai');
    expect(body.valLoss).toBe(2.4);
    expect(body.improved).toBe(true); // 2.4 < 3.0
  });

  it('should set improved=false when valLoss >= currentBestLoss', async () => {
    global.fetch = (jest.fn() as any).mockResolvedValue({ ok: true });

    await submitTrainingToExperiments('http://localhost:3000', 'p', payload, 3.5, 3.4, 10000);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(body.improved).toBe(false);
  });

  it('should not throw if fetch fails', async () => {
    global.fetch = (jest.fn() as any).mockRejectedValue(new Error('network error'));
    await expect(
      submitTrainingToExperiments('http://x', 'p', payload, 2.0, 1.9, 1000),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A5 + A7: executeTrainingWorkOrder
// ---------------------------------------------------------------------------

describe('A5+A7 — executeTrainingWorkOrder', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('should return failure for invalid JSON description', async () => {
    const wo = makeTrainingWO({ description: 'bad json' });
    global.fetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({}) });

    const result = await executeTrainingWorkOrder(wo, 'http://localhost', 'peer', ['cpu'], 1);
    expect(result.success).toBe(false);
    expect(result.result).toMatch(/Invalid training payload/);
  });

  it('should return failure when trainMicroModel throws', async () => {
    const wo = makeTrainingWO();
    global.fetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });

    // Spy on trainer
    const trainerModule = await import('../modules/model/trainer.js');
    jest.spyOn(trainerModule, 'trainMicroModel').mockRejectedValue(new Error('Python crashed'));

    const mutModule = await import('../modules/model/mutation-engine.js');
    jest.spyOn(mutModule, 'proposeMutation').mockResolvedValue({
      model: { provider: 'ollama', providerId: '', modelId: 'test' },
      type: 'explore',
      baseExperimentId: null,
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
      reasoning: 'test',
    });

    const result = await executeTrainingWorkOrder(wo, 'http://localhost', 'peer', ['cpu'], 1);
    expect(result.success).toBe(false);
    expect(result.result).toMatch(/Training failed/);
  });

  it('should return success with JSON result when training succeeds', async () => {
    const wo = makeTrainingWO();
    global.fetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });

    const trainerModule = await import('../modules/model/trainer.js');
    jest.spyOn(trainerModule, 'trainMicroModel').mockResolvedValue({
      runNumber: 1,
      finalLoss: 2.3,
      valLoss: 2.4,
      improvementPercent: 0,
      durationMs: 30000,
      config: {
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
      lossCurve: [3.0, 2.8, 2.6, 2.4],
      hardwareUsed: 'cpu',
    });

    const mutModule = await import('../modules/model/mutation-engine.js');
    jest.spyOn(mutModule, 'proposeMutation').mockResolvedValue({
      model: { provider: 'ollama', providerId: '', modelId: 'test' },
      type: 'explore',
      baseExperimentId: null,
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
      reasoning: 'test',
    });

    const result = await executeTrainingWorkOrder(wo, 'http://localhost', 'peer', ['cpu'], 1);
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.result);
    expect(parsed.valLoss).toBe(2.4);
    expect(parsed.finalLoss).toBe(2.3);
    expect(parsed.improved).toBe(true);
    expect(parsed.metricType).toBe('val_loss');
    expect(parsed.metricValue).toBe(2.4);
  });

  it('should use GPU hardware when capabilities include gpu', async () => {
    const wo = makeTrainingWO();
    global.fetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });

    const trainerModule = await import('../modules/model/trainer.js');
    const trainSpy = jest.spyOn(trainerModule, 'trainMicroModel').mockResolvedValue({
      runNumber: 1,
      finalLoss: 2.3,
      valLoss: 2.4,
      improvementPercent: 0,
      durationMs: 30000,
      config: {
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
      lossCurve: [],
      hardwareUsed: 'gpu',
    });
    const mutModule = await import('../modules/model/mutation-engine.js');
    jest.spyOn(mutModule, 'proposeMutation').mockResolvedValue({
      model: { provider: 'ollama', providerId: '', modelId: 'test' },
      type: 'explore',
      baseExperimentId: null,
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
      reasoning: 'test',
    });

    await executeTrainingWorkOrder(wo, 'http://localhost', 'peer', ['cpu', 'gpu'], 1);
    expect(trainSpy).toHaveBeenCalledWith(expect.objectContaining({ hardware: 'gpu' }));
  });

  it('should apply baseConfig from payload when provided', async () => {
    const payload: TrainingWorkOrderPayload = {
      domain: 'ai',
      datasetId: 'synthetic://text8',
      maxTrainSeconds: 30,
      currentBestLoss: 3.5,
      baseConfig: { learningRate: 0.0001, batchSize: 64 },
    };
    const wo = makeTrainingWO({ description: JSON.stringify(payload) });
    global.fetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });

    const trainerModule = await import('../modules/model/trainer.js');
    const trainSpy = jest.spyOn(trainerModule, 'trainMicroModel').mockResolvedValue({
      runNumber: 1,
      finalLoss: 2.3,
      valLoss: 2.4,
      improvementPercent: 0,
      durationMs: 30000,
      config: {
        learningRate: 0.0001,
        batchSize: 64,
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
      lossCurve: [],
      hardwareUsed: 'cpu',
    });

    const mutModule = await import('../modules/model/mutation-engine.js');
    jest.spyOn(mutModule, 'proposeMutation').mockResolvedValue({
      model: { provider: 'ollama', providerId: '', modelId: 'test' },
      type: 'explore',
      baseExperimentId: null,
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
      reasoning: 'test',
    });

    await executeTrainingWorkOrder(wo, 'http://localhost', 'peer', ['cpu'], 1);
    // baseConfig overrides: learningRate 0.001 → 0.0001, batchSize 32 → 64
    expect(trainSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({
          hyperparams: expect.objectContaining({ learningRate: 0.0001, batchSize: 64 }),
        }),
      }),
    );
  });

  it('should submit results to both endpoints after training', async () => {
    const wo = makeTrainingWO();
    const mockFetch = (jest.fn() as any).mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });
    global.fetch = mockFetch as any;

    const trainerModule = await import('../modules/model/trainer.js');
    jest.spyOn(trainerModule, 'trainMicroModel').mockResolvedValue({
      runNumber: 1,
      finalLoss: 2.3,
      valLoss: 2.4,
      improvementPercent: 0,
      durationMs: 30000,
      config: {
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
      lossCurve: [],
      hardwareUsed: 'cpu',
    });
    const mutModule = await import('../modules/model/mutation-engine.js');
    jest.spyOn(mutModule, 'proposeMutation').mockResolvedValue({
      model: { provider: 'ollama', providerId: '', modelId: 'test' },
      type: 'explore',
      baseExperimentId: null,
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
      reasoning: 'test',
    });

    await executeTrainingWorkOrder(wo, 'http://localhost:3000', 'peer', ['cpu'], 1);

    const urls = mockFetch.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
    expect(urls.some((u: string) => u.includes('/hyperparams/experiments'))).toBe(true);
    expect(urls.some((u: string) => u.includes('/experiments'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A6: canTrain / buildCapabilities
// ---------------------------------------------------------------------------

describe('A6 — canTrain / buildCapabilities', () => {
  it('canTrain is a function', () => {
    expect(typeof canTrain).toBe('function');
  });

  it('canTrain returns a boolean', () => {
    const result = canTrain();
    expect(typeof result).toBe('boolean');
  });

  it('HardwareHelper.canTrain returns boolean', () => {
    const helper = new HardwareHelper();
    const result = helper.canTrain();
    expect(typeof result).toBe('boolean');
  });

  it('buildCapabilities includes cpu for any hardware', () => {
    const helper = new HardwareHelper();
    const hardware = { cpuCores: 4, ramGb: 16, gpuVramGb: 0, tier: 0 as const, hasOllama: false };
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    const caps = helper.buildCapabilities(hardware);
    expect(caps).toContain('cpu');
    expect(caps).not.toContain('training');
    expect(caps).not.toContain('gpu');
  });

  it('buildCapabilities includes gpu when gpuVramGb > 0', () => {
    const helper = new HardwareHelper();
    const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 24, tier: 4 as const, hasOllama: false };
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    const caps = helper.buildCapabilities(hardware);
    expect(caps).toContain('gpu');
  });

  it('buildCapabilities includes training when canTrain() returns true', () => {
    const helper = new HardwareHelper();
    const hardware = { cpuCores: 4, ramGb: 16, gpuVramGb: 0, tier: 0 as const, hasOllama: false };
    jest.spyOn(helper, 'canTrain').mockReturnValue(true);
    const caps = helper.buildCapabilities(hardware);
    expect(caps).toContain('training');
  });

  it('buildCapabilities standalone function returns an array', () => {
    const hardware = { cpuCores: 4, ramGb: 16, gpuVramGb: 0, tier: 0 as const, hasOllama: false };
    const caps = buildCapabilities(hardware);
    expect(Array.isArray(caps)).toBe(true);
  });
});
