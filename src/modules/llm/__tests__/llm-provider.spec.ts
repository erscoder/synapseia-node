/**
 * LlmProviderHelper — dispatch, retry, and migration coverage.
 *
 * After the move to per-provider adapters, the wire-protocol details
 * (URL building, response shape parsing, error extraction) live in
 * adapters/__tests__/ — those file own their own coverage. This spec
 * focuses on the helper itself: parseModel, retry behaviour, the
 * Ollama / Synapseia paths, and that the cloud dispatch does call
 * through the adapter for each whitelisted provider.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  LlmProviderHelper,
  isTransientLlmError,
  SUPPORTED_MODELS,
  MODEL_METADATA,
  type LLMModel,
} from '../llm-provider';

// ── helpers ───────────────────────────────────────────────────────────────
const originalFetch = global.fetch;
function mockFetchOnce(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  text?: string;
} = {}) {
  const body = opts.body ?? {};
  (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    text: async () => (opts.text !== undefined ? opts.text : JSON.stringify(body)),
  });
}

interface OllamaMock {
  checkOllama: jest.Mock;
  generate: jest.Mock;
}

function makeHelper(synapseia?: unknown): { helper: LlmProviderHelper; ollama: OllamaMock } {
  const helper = new LlmProviderHelper(synapseia as never);
  const ollama: OllamaMock = {
    checkOllama: jest.fn(),
    generate: jest.fn(),
  };
  (helper as unknown as { ollamaHelper: OllamaMock }).ollamaHelper = ollama;
  return { helper, ollama };
}

beforeEach(() => { (global as { fetch: unknown }).fetch = jest.fn(); });
afterEach(() => { (global as { fetch: unknown }).fetch = originalFetch; });

// ── isTransientLlmError ───────────────────────────────────────────────────
describe('isTransientLlmError', () => {
  const transient = [
    'Minimax error 2064',
    'Server under HIGH LOAD',
    'provider overloaded — retry',
    'rate limit exceeded',
    'Rate-Limit hit',
    'Too Many Requests',
    'HTTP 429',
    'HTTP 502 bad gateway',
    '503 service unavailable',
    'gateway 504 timeout',
    'request timeout',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'socket hang up',
    'ollama runner process died',
    '%!w(<nil>)',
    'Unexpected EOF',
    'please try again',
    'something something (transient)',
  ];
  for (const msg of transient) {
    it(`is transient: "${msg}"`, () => {
      expect(isTransientLlmError(new Error(msg))).toBe(true);
    });
  }

  it('is NOT transient for auth / bad-prompt errors', () => {
    expect(isTransientLlmError(new Error('invalid api key'))).toBe(false);
    expect(isTransientLlmError(new Error('model not found'))).toBe(false);
    expect(isTransientLlmError(new Error('messages: at least one required'))).toBe(false);
  });
});

// ── toErrorMessage ────────────────────────────────────────────────────────
describe('LlmProviderHelper.toErrorMessage', () => {
  const { helper } = makeHelper();
  it('returns the error message when present', () => {
    expect(helper.toErrorMessage(new Error('boom'))).toBe('boom');
  });
  it('returns "Unknown error" for null / undefined', () => {
    expect(helper.toErrorMessage(null)).toBe('Unknown error');
    expect(helper.toErrorMessage(undefined)).toBe('Unknown error');
  });
});

// ── parseModel ────────────────────────────────────────────────────────────
describe('LlmProviderHelper.parseModel', () => {
  const { helper } = makeHelper();

  it('matches every SUPPORTED_MODELS key exactly', () => {
    for (const key of Object.keys(SUPPORTED_MODELS)) {
      expect(helper.parseModel(key)).toEqual(SUPPORTED_MODELS[key]);
    }
  });

  it('accepts off-list ollama models (vendors release new tags)', () => {
    expect(helper.parseModel('ollama/some-future:tag')).toEqual({
      provider: 'ollama',
      providerId: '',
      modelId: 'some-future:tag',
    });
  });

  it('accepts off-list cloud models when the provider is whitelisted', () => {
    expect(helper.parseModel('openai/gpt-7-turbo')).toEqual({
      provider: 'cloud',
      providerId: 'openai',
      modelId: 'gpt-7-turbo',
    });
  });

  it('rejects deprecated kimi/* slugs (migration handles those at config load)', () => {
    expect(helper.parseModel('kimi/k99')).toBeNull();
  });

  it('rejects openai-compat/* (no longer whitelisted)', () => {
    expect(helper.parseModel('openai-compat/foo')).toBeNull();
  });

  it('returns null on empty / malformed input', () => {
    expect(helper.parseModel('')).toBeNull();
    expect(helper.parseModel('no-slash')).toBeNull();
    expect(helper.parseModel('foo/')).toBeNull();
    expect(helper.parseModel('/bar')).toBeNull();
  });
});

// ── SUPPORTED_MODELS / MODEL_METADATA shape ──────────────────────────────
describe('SUPPORTED_MODELS / MODEL_METADATA', () => {
  it('contains the six top-tier cloud slugs we expect to ship', () => {
    expect(SUPPORTED_MODELS['openai/gpt-5']).toBeDefined();
    expect(SUPPORTED_MODELS['anthropic/claude-sonnet-4-6']).toBeDefined();
    expect(SUPPORTED_MODELS['google/gemini-2.5-pro']).toBeDefined();
    expect(SUPPORTED_MODELS['moonshot/kimi-k2.6']).toBeDefined();
    expect(SUPPORTED_MODELS['minimax/MiniMax-M2.7']).toBeDefined();
    expect(SUPPORTED_MODELS['zhipu/glm-4.6']).toBeDefined();
  });

  it('does NOT expose obsolete openai-compat / kimi entries', () => {
    expect(SUPPORTED_MODELS['openai-compat/asi1']).toBeUndefined();
    expect(SUPPORTED_MODELS['openai-compat/custom']).toBeUndefined();
    expect(SUPPORTED_MODELS['kimi/k2.5']).toBeUndefined();
  });

  it('exposes per-model metadata with cost only for cloud entries', () => {
    expect(MODEL_METADATA['qwen2.5:0.5b']?.costPerCall).toBeUndefined();
    expect(MODEL_METADATA['claude-sonnet-4-6']?.costPerCall).toBe(0.003);
    expect(MODEL_METADATA['MiniMax-M2.7']?.costPerCall).toBe(0.0015);
  });
});

// ── public getters ────────────────────────────────────────────────────────
describe('LlmProviderHelper — public getters', () => {
  const { helper } = makeHelper();
  it('supportedModels exposes SUPPORTED_MODELS', () => {
    expect(helper.supportedModels).toBe(SUPPORTED_MODELS);
  });
  it('modelMetadata exposes MODEL_METADATA', () => {
    expect(helper.modelMetadata).toBe(MODEL_METADATA);
  });
});

// ── checkLLM dispatch ─────────────────────────────────────────────────────
describe('LlmProviderHelper.checkLLM', () => {
  const ollamaModel: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' };
  const anthropicModel: LLMModel = {
    provider: 'cloud', providerId: 'anthropic', modelId: 'claude-sonnet-4-6',
  };

  it('dispatches to Ollama and returns latency from MODEL_METADATA', async () => {
    const { helper, ollama } = makeHelper();
    ollama.checkOllama.mockResolvedValueOnce({ available: true, models: ['qwen2.5:3b'], error: null });
    const r = await helper.checkLLM(ollamaModel);
    expect(r.available).toBe(true);
    expect(r.estimatedLatencyMs).toBe(800);
  });

  it('cloud: rejects when apiKey missing', async () => {
    const { helper } = makeHelper();
    const r = await helper.checkLLM(anthropicModel);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/API key required/);
  });

  it('cloud: marks available + cost when adapter returns a usable response', async () => {
    const { helper } = makeHelper();
    mockFetchOnce({
      body: {
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const r = await helper.checkLLM(anthropicModel, { apiKey: 'k' });
    expect(r.available).toBe(true);
    expect(r.estimatedCostPerCall).toBe(0.003);
  });

  it('cloud: unknown providerId returns not-available', async () => {
    const { helper } = makeHelper();
    const r = await helper.checkLLM(
      { provider: 'cloud', providerId: 'foobar' as never, modelId: 'x' },
      { apiKey: 'k' },
    );
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/Unknown cloud provider/);
  });

  it('synapseia: returns not-available when client not wired', async () => {
    const { helper } = makeHelper(undefined);
    const r = await helper.checkLLM({ provider: 'synapseia', providerId: '', modelId: 'm' });
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/not wired/);
  });
});

// ── generateLLM dispatch + retry ──────────────────────────────────────────
describe('LlmProviderHelper.generateLLM', () => {
  const ollamaModel: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' };
  const anthropicModel: LLMModel = {
    provider: 'cloud', providerId: 'anthropic', modelId: 'claude-sonnet-4-6',
  };
  const minimaxModel: LLMModel = {
    provider: 'cloud', providerId: 'minimax', modelId: 'MiniMax-M2.7',
  };

  it('returns ollama content on first-try success', async () => {
    const { helper, ollama } = makeHelper();
    ollama.generate.mockResolvedValueOnce('hello');
    expect(await helper.generateLLM(ollamaModel, 'ping')).toBe('hello');
    expect(ollama.generate).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-transient errors immediately (no retries)', async () => {
    const { helper, ollama } = makeHelper();
    ollama.generate.mockRejectedValueOnce(new Error('invalid api key'));
    await expect(helper.generateLLM(ollamaModel, 'p')).rejects.toThrow(/invalid api key/);
    expect(ollama.generate).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error then succeeds', async () => {
    jest.useFakeTimers();
    try {
      const { helper, ollama } = makeHelper();
      ollama.generate
        .mockRejectedValueOnce(new Error('runner process died'))
        .mockResolvedValueOnce('recovered');
      const p = helper.generateLLM(ollamaModel, 'ping');
      await jest.advanceTimersByTimeAsync(1001);
      await expect(p).resolves.toBe('recovered');
      expect(ollama.generate).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('stops retrying after 4 attempts (3 retries) and rethrows the last error', async () => {
    jest.useFakeTimers();
    try {
      const { helper, ollama } = makeHelper();
      ollama.generate.mockRejectedValue(new Error('overloaded'));
      const p = helper.generateLLM(ollamaModel, 'ping').catch((e) => e);
      await jest.advanceTimersByTimeAsync(1001);
      await jest.advanceTimersByTimeAsync(3001);
      await jest.advanceTimersByTimeAsync(8001);
      const err = await p;
      expect(String(err)).toMatch(/overloaded/);
      expect(ollama.generate).toHaveBeenCalledTimes(4);
    } finally { jest.useRealTimers(); }
  });

  it('strips reasoning tags from final ollama output', async () => {
    const { helper, ollama } = makeHelper();
    ollama.generate.mockResolvedValueOnce('<think>scratchpad</think>the answer');
    const r = await helper.generateLLM(ollamaModel, 'ping');
    expect(r).not.toContain('<think>');
    expect(r).toContain('the answer');
  });

  it('throws on unknown top-level provider', async () => {
    const { helper } = makeHelper();
    await expect(helper.generateLLM(
      { provider: 'nobody' as never, providerId: '', modelId: 'm' },
      'p',
    )).rejects.toThrow(/Unknown provider/);
  });

  it('cloud: throws when apiKey missing', async () => {
    const { helper } = makeHelper();
    await expect(helper.generateLLM(anthropicModel, 'p')).rejects.toThrow(/API key required/);
  });

  it('cloud: dispatches to anthropic adapter and returns the text block', async () => {
    const { helper } = makeHelper();
    mockFetchOnce({
      body: {
        content: [{ type: 'text', text: 'anthropic-reply' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    const r = await helper.generateLLM(anthropicModel, 'p', { apiKey: 'k' });
    expect(r).toBe('anthropic-reply');
  });

  it('cloud: minimax 2064 base_resp marks transient and retries', async () => {
    jest.useFakeTimers();
    try {
      const { helper } = makeHelper();
      // First attempt: HTTP 200 with base_resp 2064 → adapter throws transient.
      mockFetchOnce({
        body: { base_resp: { status_code: 2064, status_msg: 'high load' } },
      });
      // Second attempt: success.
      mockFetchOnce({
        body: {
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'final' } }],
          base_resp: { status_code: 0, status_msg: '' },
        },
      });
      const promise = helper.generateLLM(minimaxModel, 'hi', { apiKey: 'k' });
      await jest.advanceTimersByTimeAsync(1100);
      await expect(promise).resolves.toBe('final');
    } finally { jest.useRealTimers(); }
  });

  it('cloud: rejects unknown providerId without retries', async () => {
    const { helper } = makeHelper();
    await expect(helper.generateLLM(
      { provider: 'cloud', providerId: 'foo' as never, modelId: 'x' },
      'p',
      { apiKey: 'k' },
    )).rejects.toThrow(/Unknown cloud provider/);
  });

  it('synapseia: throws when client not wired', async () => {
    const { helper } = makeHelper();
    await expect(helper.generateLLM(
      { provider: 'synapseia', providerId: '', modelId: 'm' },
      'p',
    )).rejects.toThrow(/not wired/);
  });

  it('synapseia: throws on version mismatch', async () => {
    const client = {
      isAvailable: jest.fn(async () => true),
      getActiveVersion: jest.fn(() => 'synapseia-agent:gen-1:v1'),
      generate: jest.fn(async () => ({ content: 'x' })),
    };
    const { helper } = makeHelper(client);
    await expect(helper.generateLLM(
      { provider: 'synapseia', providerId: '', modelId: 'm', synapseiaVersion: 'synapseia-agent:gen-2:v0' },
      'p',
    )).rejects.toThrow(/version mismatch/);
  });

  it('synapseia: happy path returns client.generate content', async () => {
    const client = {
      isAvailable: jest.fn(async () => true),
      getActiveVersion: jest.fn(() => 'synapseia-agent:gen-1:v1'),
      generate: jest.fn(async () => ({ content: 'SYN OUTPUT' })),
    };
    const { helper } = makeHelper(client);
    const r = await helper.generateLLM(
      { provider: 'synapseia', providerId: '', modelId: 'm', synapseiaVersion: 'synapseia-agent:gen-1:v1' },
      'hi',
      undefined,
      { temperature: 0.3, maxTokens: 128 },
    );
    expect(r).toBe('SYN OUTPUT');
    expect(client.generate).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0.3, maxTokens: 128,
    }));
  });
});

// ── ollama passthroughs ───────────────────────────────────────────────────
describe('LlmProviderHelper — ollama passthrough', () => {
  it('checkOllama delegates to OllamaHelper', async () => {
    const { helper, ollama } = makeHelper();
    ollama.checkOllama.mockResolvedValueOnce('ok');
    expect(await helper.checkOllama()).toBe('ok');
  });

  it('generateOllama delegates to OllamaHelper.generate', async () => {
    const { helper, ollama } = makeHelper();
    ollama.generate.mockResolvedValueOnce('result');
    expect(await helper.generateOllama('prompt', 'qwen')).toBe('result');
  });
});
