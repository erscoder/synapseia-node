/**
 * Sprint F Tests — CPU Inference Work Order (node side)
 * Covers: F3 (isCpuInferenceWorkOrder, executeCpuInferenceWorkOrder)
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  isCpuInferenceWorkOrder,
  executeCpuInferenceWorkOrder,
  type WorkOrder,
  type CpuInferenceWorkOrderPayload,
} from '../modules/agent/work-order-agent.js';

// ---------------------------------------------------------------------------
// Mock generateLLM
// ---------------------------------------------------------------------------

jest.mock('../modules/llm/llm-provider.js', () => ({
  generateLLM: jest.fn(),
  parseModel: jest.fn((s: string) => ({ provider: 'ollama', modelId: s })),
}));

import { generateLLM } from '../modules/llm/llm-provider.js';

const mockGenerateLLM = generateLLM as jest.MockedFunction<typeof generateLLM>;

function makeLLMModel() {
  return { provider: 'ollama' as const, providerId: '' as const, modelId: 'phi4-mini' };
}

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo_test_1',
    title: 'CPU Inference Task',
    description: JSON.stringify({ task: 'embedding', input: 'hello world test' }),
    requiredCapabilities: ['cpu_inference'],
    rewardAmount: '15.000000000',
    status: 'PENDING',
    creatorAddress: 'coordinator_system',
    createdAt: Date.now(),
    type: 'cpu_inference' as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isCpuInferenceWorkOrder
// ---------------------------------------------------------------------------

describe('isCpuInferenceWorkOrder', () => {
  it('should return true when type is cpu_inference (lowercase)', () => {
    const wo = makeWorkOrder({ type: 'cpu_inference' as any, requiredCapabilities: [] });
    expect(isCpuInferenceWorkOrder(wo)).toBe(true);
  });

  it('should return true when type is CPU_INFERENCE (uppercase)', () => {
    const wo = makeWorkOrder({ type: 'CPU_INFERENCE' as any, requiredCapabilities: [] });
    expect(isCpuInferenceWorkOrder(wo)).toBe(true);
  });

  it('should return true when requiredCapabilities includes cpu_inference', () => {
    const wo = makeWorkOrder({ type: 'COMPUTATION' as any, requiredCapabilities: ['cpu_inference'] });
    expect(isCpuInferenceWorkOrder(wo)).toBe(true);
  });

  it('should return true when description contains valid cpu_inference payload', () => {
    const payload: CpuInferenceWorkOrderPayload = { task: 'classify', input: 'some text' };
    const wo = makeWorkOrder({
      type: 'COMPUTATION' as any,
      requiredCapabilities: [],
      description: JSON.stringify(payload),
    });
    expect(isCpuInferenceWorkOrder(wo)).toBe(true);
  });

  it('should return false for TRAINING work orders', () => {
    const wo = makeWorkOrder({
      type: 'TRAINING' as any,
      requiredCapabilities: ['training'],
      description: JSON.stringify({ domain: 'ai', datasetId: 'ds://ai', maxTrainSeconds: 300, currentBestLoss: 999 }),
    });
    expect(isCpuInferenceWorkOrder(wo)).toBe(false);
  });

  it('should return false for RESEARCH work orders', () => {
    const wo = makeWorkOrder({
      type: 'RESEARCH' as any,
      requiredCapabilities: [],
      description: JSON.stringify({ title: 'Paper', abstract: 'Abstract text' }),
    });
    expect(isCpuInferenceWorkOrder(wo)).toBe(false);
  });

  it('should return false for standard COMPUTATION with no cpu_inference payload', () => {
    const wo = makeWorkOrder({
      type: 'COMPUTATION' as any,
      requiredCapabilities: [],
      description: 'Some plain description without JSON',
    });
    expect(isCpuInferenceWorkOrder(wo)).toBe(false);
  });

  it('should return false for invalid JSON description', () => {
    const wo = makeWorkOrder({
      type: 'COMPUTATION' as any,
      requiredCapabilities: [],
      description: 'not json {{{',
    });
    expect(isCpuInferenceWorkOrder(wo)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeCpuInferenceWorkOrder — embedding
// ---------------------------------------------------------------------------

describe('executeCpuInferenceWorkOrder — embedding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return an array output for embedding task', async () => {
    mockGenerateLLM.mockResolvedValue('[0.1, 0.2, -0.3, 0.4, 0.5, -0.6, 0.7, 0.8]');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'embedding', input: 'hello world' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(Array.isArray(result.output)).toBe(true);
    expect(result.tokensProcessed).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.modelUsed).toBe('string');
  });

  it('should use modelHint as modelUsed if provided', async () => {
    mockGenerateLLM.mockResolvedValue('[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'embedding', input: 'test', modelHint: 'my-model' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(result.modelUsed).toBe('my-model');
  });

  it('should fallback to mock embedding when LLM response is not a valid JSON array', async () => {
    mockGenerateLLM.mockResolvedValue('Sorry, I cannot generate that.');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'embedding', input: 'hello world test' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(Array.isArray(result.output)).toBe(true);
    expect((result.output as number[]).length).toBeGreaterThan(0);
  });

  it('should fallback to mock embedding when LLM throws', async () => {
    mockGenerateLLM.mockRejectedValue(new Error('LLM error'));

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'embedding', input: 'hello world' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(Array.isArray(result.output)).toBe(true);
  });

  it('should strip <think> blocks from LLM response before parsing', async () => {
    mockGenerateLLM.mockResolvedValue('<think>reasoning here</think>[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'embedding', input: 'hello' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(Array.isArray(result.output)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeCpuInferenceWorkOrder — tokenize
// ---------------------------------------------------------------------------

describe('executeCpuInferenceWorkOrder — tokenize', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should NOT call generateLLM for tokenize task', async () => {
    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'tokenize', input: 'hello world test tokens' }),
    });
    await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(mockGenerateLLM).not.toHaveBeenCalled();
  });

  it('should return string output with token count for tokenize', async () => {
    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'tokenize', input: 'one two three four five' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(typeof result.output).toBe('string');
    expect(result.tokensProcessed).toBe(5);
  });

  it('should handle single-word input for tokenize', async () => {
    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'tokenize', input: 'hello' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(result.tokensProcessed).toBe(1);
  });

  it('should handle multi-space input for tokenize', async () => {
    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'tokenize', input: 'word1  word2   word3' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(result.tokensProcessed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// executeCpuInferenceWorkOrder — classify
// ---------------------------------------------------------------------------

describe('executeCpuInferenceWorkOrder — classify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return a string label for classify task', async () => {
    mockGenerateLLM.mockResolvedValue('positive');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'classify', input: 'great product love it' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(typeof result.output).toBe('string');
    expect(result.output).toBe('positive');
  });

  it('should lowercase the classification label', async () => {
    mockGenerateLLM.mockResolvedValue('NEGATIVE');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'classify', input: 'terrible experience' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(result.output).toBe('negative');
  });

  it('should extract first word from LLM response for classify', async () => {
    mockGenerateLLM.mockResolvedValue('technical This is a technical document.');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'classify', input: 'API endpoint documentation' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(result.output).toBe('technical');
  });

  it('should fallback to neutral when LLM throws for classify', async () => {
    mockGenerateLLM.mockRejectedValue(new Error('timeout'));

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'classify', input: 'some text' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(result.output).toBe('neutral');
  });

  it('should strip <think> blocks from classify response', async () => {
    mockGenerateLLM.mockResolvedValue('<think>Analyzing...</think>medical');

    const wo = makeWorkOrder({
      description: JSON.stringify({ task: 'classify', input: 'patient diagnosis report' }),
    });
    const result = await executeCpuInferenceWorkOrder(wo, makeLLMModel());

    expect(result.output).toBe('medical');
  });
});

// ---------------------------------------------------------------------------
// executeCpuInferenceWorkOrder — error handling
// ---------------------------------------------------------------------------

describe('executeCpuInferenceWorkOrder — error handling', () => {
  it('should throw when description is not valid JSON', async () => {
    const wo = makeWorkOrder({
      description: 'not json {{{',
    });
    await expect(executeCpuInferenceWorkOrder(wo, makeLLMModel())).rejects.toThrow(
      'Invalid CPU inference payload',
    );
  });
});
