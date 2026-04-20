/**
 * LlmProviderHelper — comprehensive spec (Phase 4 mutation coverage).
 *
 * Targets the pure helpers (isTransientLlmError, parseModel, toErrorMessage,
 * getOptionalString, buildOpenAICompatUrl, extractHttpErrorMessage), the
 * provider dispatch (checkLLM / generateLLM), and the 4-attempt retry
 * schedule on transient errors. Provider-specific HTTP paths are
 * exercised through fetch mocks.
 *
 * OllamaHelper is swapped by assignment into the private field because
 * the helper instantiates it in the constructor.
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
function mockFetchOnce(opts: { ok?: boolean; status?: number; statusText?: string; body?: any; text?: string; isJson?: boolean } = {}) {
  const body = opts.body ?? {};
  (global.fetch as any).mockResolvedValueOnce({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    json: async () => body,
    text: async () => (opts.text !== undefined ? opts.text : JSON.stringify(body)),
  });
}

function makeHelper(synapseia?: any): { helper: LlmProviderHelper; ollama: any } {
  const helper = new LlmProviderHelper(synapseia as any);
  // Override the private ollamaHelper field with a minimal fake.
  const ollama = {
    checkOllama: jest.fn<any>(),
    generate: jest.fn<any>(),
  };
  (helper as any).ollamaHelper = ollama;
  return { helper, ollama };
}

beforeEach(() => { (global as any).fetch = jest.fn(); });
afterEach(() => { (global as any).fetch = originalFetch; });

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
  ];
  for (const msg of transient) {
    it(`is transient: "${msg}"`, () => {
      expect(isTransientLlmError(new Error(msg))).toBe(true);
    });
  }

  it('is NOT transient for auth / bad-prompt errors', () => {
    expect(isTransientLlmError(new Error('invalid api key'))).toBe(false);
    expect(isTransientLlmError(new Error('model not found'))).toBe(false);
    expect(isTransientLlmError(new Error('prompt exceeds context'))).toBe(false);
  });

  it('handles non-Error inputs gracefully', () => {
    expect(isTransientLlmError(null)).toBe(false);
    expect(isTransientLlmError(undefined)).toBe(false);
    // Raw strings get stringified + lowercased and still flow through the
    // substring matcher, so a plain "boom" is NOT transient.
    expect(isTransientLlmError('boom')).toBe(false);
    // …but a raw string containing a transient keyword IS transient — the
    // matcher is keyword-based, not type-based.
    expect(isTransientLlmError('rate limit')).toBe(true);
  });

  it('coerces a raw 429 string via message property', () => {
    expect(isTransientLlmError({ message: 'HTTP 429' })).toBe(true);
  });
});

// ── toErrorMessage + getOptionalString ────────────────────────────────────
describe('LlmProviderHelper.toErrorMessage', () => {
  const { helper } = makeHelper();
  it('returns the error message when present', () => {
    expect(helper.toErrorMessage(new Error('boom'))).toBe('boom');
  });
  it('returns "Unknown error" for null / undefined', () => {
    expect(helper.toErrorMessage(null)).toBe('Unknown error');
    expect(helper.toErrorMessage(undefined)).toBe('Unknown error');
  });
  it('returns "Unknown error" when String() throws', () => {
    const weird = { get message() { throw new Error('bad'); } };
    expect(helper.toErrorMessage(weird)).toBe('Unknown error');
  });
});

describe('LlmProviderHelper.getOptionalString', () => {
  const { helper } = makeHelper();
  it('returns undefined on null object', () => {
    expect(helper.getOptionalString(null, 'x' as any)).toBeUndefined();
  });
  it('returns undefined on undefined object', () => {
    expect(helper.getOptionalString(undefined, 'x' as any)).toBeUndefined();
  });
  it('returns undefined when value is not a string', () => {
    expect(helper.getOptionalString({ x: 42 } as any, 'x' as any)).toBeUndefined();
    expect(helper.getOptionalString({ x: null } as any, 'x' as any)).toBeUndefined();
  });
  it('returns the string when present', () => {
    expect(helper.getOptionalString({ x: 'hello' } as any, 'x' as any)).toBe('hello');
  });
});

// ── parseModel ────────────────────────────────────────────────────────────
describe('LlmProviderHelper.parseModel', () => {
  const { helper } = makeHelper();

  it('matches known SUPPORTED_MODELS keys exactly', () => {
    for (const key of Object.keys(SUPPORTED_MODELS)) {
      expect(helper.parseModel(key)).toEqual(SUPPORTED_MODELS[key]);
    }
  });

  it('falls back to openai-compat/<modelId> prefix', () => {
    expect(helper.parseModel('openai-compat/my-custom'))
      .toEqual({ provider: 'cloud', providerId: 'openai-compat', modelId: 'my-custom' });
  });

  it('falls back to minimax/<modelId> prefix', () => {
    expect(helper.parseModel('minimax/M2.8-preview'))
      .toEqual({ provider: 'cloud', providerId: 'minimax', modelId: 'M2.8-preview' });
  });

  it('accepts kimi/ OR moonshot/ prefix for moonshot', () => {
    expect(helper.parseModel('kimi/k99')).toEqual({ provider: 'cloud', providerId: 'moonshot', modelId: 'k99' });
    expect(helper.parseModel('moonshot/k99')).toEqual({ provider: 'cloud', providerId: 'moonshot', modelId: 'k99' });
  });

  it('returns null on empty modelId after the slash', () => {
    expect(helper.parseModel('openai-compat/')).toBeNull();
    expect(helper.parseModel('minimax/')).toBeNull();
    expect(helper.parseModel('kimi/')).toBeNull();
  });

  it('returns null on unknown prefix', () => {
    expect(helper.parseModel('claude-desktop/unknown')).toBeNull();
    expect(helper.parseModel('')).toBeNull();
  });
});

// ── buildOpenAICompatUrl / extractHttpErrorMessage ────────────────────────
describe('LlmProviderHelper.buildOpenAICompatUrl', () => {
  const { helper } = makeHelper();
  it('defaults to https://api.openai.com/v1/chat/completions', () => {
    expect((helper as any).buildOpenAICompatUrl(undefined)).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('appends /v1/chat/completions to a root host', () => {
    expect((helper as any).buildOpenAICompatUrl('https://my.host')).toBe('https://my.host/v1/chat/completions');
  });

  it('leaves already-complete endpoints untouched', () => {
    expect((helper as any).buildOpenAICompatUrl('https://my.host/v1/chat/completions'))
      .toBe('https://my.host/v1/chat/completions');
  });

  it('strips trailing slashes before deciding', () => {
    expect((helper as any).buildOpenAICompatUrl('https://my.host/v1/chat/completions/'))
      .toBe('https://my.host/v1/chat/completions');
    expect((helper as any).buildOpenAICompatUrl('https://my.host///'))
      .toBe('https://my.host/v1/chat/completions');
  });
});

describe('LlmProviderHelper.extractHttpErrorMessage', () => {
  const { helper } = makeHelper();

  function fakeResp(status: number, statusText: string, text: string) {
    return {
      status, statusText,
      text: async () => text,
    } as any;
  }

  it('prefers JSON body.error.message when present', async () => {
    const res = fakeResp(400, 'Bad Request', JSON.stringify({ error: { message: 'invalid model' } }));
    expect(await (helper as any).extractHttpErrorMessage(res)).toBe('invalid model');
  });

  it('falls back to JSON body.message when .error.message is absent', async () => {
    const res = fakeResp(400, 'Bad Request', JSON.stringify({ message: 'bad json' }));
    expect(await (helper as any).extractHttpErrorMessage(res)).toBe('bad json');
  });

  it('falls back to `HTTP <status> <statusText>: <snippet>` on HTML bodies', async () => {
    const res = fakeResp(502, 'Bad Gateway', '<html><body>oops</body></html>');
    const msg = await (helper as any).extractHttpErrorMessage(res);
    expect(msg).toContain('HTTP 502 Bad Gateway');
    expect(msg).toContain('oops');
  });

  it('handles completely empty bodies', async () => {
    const res = fakeResp(500, 'Server Error', '');
    expect(await (helper as any).extractHttpErrorMessage(res)).toBe('HTTP 500 Server Error');
  });

  it('truncates long HTML snippets to 200 chars', async () => {
    const longHtml = 'x'.repeat(500);
    const res = fakeResp(500, 'E', longHtml);
    const msg = await (helper as any).extractHttpErrorMessage(res);
    // msg length: "HTTP 500 E: " + 200 chars snippet = 212
    expect(msg.length).toBeLessThanOrEqual(250);
  });
});

// ── supportedModels / modelMetadata getters ───────────────────────────────
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
  it('dispatches to Ollama when provider=ollama', async () => {
    const { helper, ollama } = makeHelper();
    ollama.checkOllama.mockResolvedValueOnce({ available: true, models: ['qwen2.5:3b'], error: null });
    const r = await helper.checkLLM({ provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' });
    expect(r.available).toBe(true);
    expect(r.estimatedLatencyMs).toBe(800); // from MODEL_METADATA
  });

  it('ollama: returns not-available + error when ollama check returns no', async () => {
    const { helper, ollama } = makeHelper();
    ollama.checkOllama.mockResolvedValueOnce({ available: false, models: [], error: 'not running' });
    const r = await helper.checkLLM({ provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' });
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/not running/);
  });

  it('ollama: returns not-available with instructions when model missing', async () => {
    const { helper, ollama } = makeHelper();
    ollama.checkOllama.mockResolvedValueOnce({ available: true, models: ['llama3.2:3b'], error: null });
    const r = await helper.checkLLM({ provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' });
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/Pull with: ollama pull qwen2\.5:3b/);
  });

  it('ollama: catches ollamaHelper throw and maps to error message', async () => {
    const { helper, ollama } = makeHelper();
    ollama.checkOllama.mockRejectedValueOnce(new Error('ollama exploded'));
    const r = await helper.checkLLM({ provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' });
    expect(r.available).toBe(false);
    expect(r.error).toBe('ollama exploded');
  });

  it('cloud: rejects with error when no API key is provided', async () => {
    const { helper } = makeHelper();
    const r = await helper.checkLLM({ provider: 'cloud', providerId: 'anthropic', modelId: 'sonnet-4.6' });
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/API key required/);
  });

  it('cloud: dispatches to anthropic', async () => {
    const { helper } = makeHelper();
    mockFetchOnce({ ok: true });
    const r = await helper.checkLLM(
      { provider: 'cloud', providerId: 'anthropic', modelId: 'sonnet-4.6' },
      { apiKey: 'k' },
    );
    expect(r.available).toBe(true);
    expect(r.estimatedCostPerCall).toBe(0.003);
  });

  it('cloud: unknown providerId returns not-available', async () => {
    const { helper } = makeHelper();
    const r = await helper.checkLLM(
      { provider: 'cloud', providerId: 'foobar' as any, modelId: 'x' },
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

  it('synapseia: delegates isAvailable() when client is wired', async () => {
    const client = { isAvailable: jest.fn(async () => true), getActiveVersion: jest.fn(), generate: jest.fn() };
    const { helper } = makeHelper(client);
    const r = await helper.checkLLM({ provider: 'synapseia', providerId: '', modelId: 'm' });
    expect(r.available).toBe(true);
    expect(r.estimatedLatencyMs).toBe(600);
  });

  it('synapseia: surfaces local-serving-runtime error when isAvailable=false', async () => {
    const client = { isAvailable: jest.fn(async () => false), getActiveVersion: jest.fn(), generate: jest.fn() };
    const { helper } = makeHelper(client);
    const r = await helper.checkLLM({ provider: 'synapseia', providerId: '', modelId: 'm' });
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/not reachable/);
  });

  it('unknown top-level provider returns not-available', async () => {
    const { helper } = makeHelper();
    const r = await helper.checkLLM({ provider: 'mystery' as any, providerId: '', modelId: 'm' });
    expect(r.available).toBe(false);
    expect(r.error).toBe('Unknown provider');
  });
});

// ── generateLLM retry schedule ────────────────────────────────────────────
describe('LlmProviderHelper.generateLLM', () => {
  it('returns ollama content on first-try success', async () => {
    const { helper, ollama } = makeHelper();
    ollama.generate.mockResolvedValueOnce('hello');
    const r = await helper.generateLLM(
      { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' },
      'ping',
    );
    expect(r).toBe('hello');
    expect(ollama.generate).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-transient errors immediately (no retries)', async () => {
    const { helper, ollama } = makeHelper();
    ollama.generate.mockRejectedValueOnce(new Error('invalid api key'));
    await expect(helper.generateLLM(
      { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' },
      'ping',
    )).rejects.toThrow(/invalid api key/);
    expect(ollama.generate).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error then succeeds', async () => {
    jest.useFakeTimers();
    try {
      const { helper, ollama } = makeHelper();
      ollama.generate
        .mockRejectedValueOnce(new Error('runner process died'))
        .mockResolvedValueOnce('recovered');
      const p = helper.generateLLM(
        { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' },
        'ping',
      );
      // Advance timers past the 1s backoff.
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
      const p = helper.generateLLM(
        { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' },
        'ping',
      ).catch((e) => e);
      // Drain all 3 retry backoffs (1s, 3s, 8s).
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
    const r = await helper.generateLLM(
      { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' },
      'ping',
    );
    expect(r).not.toContain('<think>');
    expect(r).toContain('the answer');
  });

  it('throws on unknown top-level provider', async () => {
    const { helper } = makeHelper();
    await expect(helper.generateLLM(
      { provider: 'nobody' as any, providerId: '', modelId: 'm' },
      'p',
    )).rejects.toThrow(/Unknown provider/);
  });

  it('cloud: throws when apiKey missing', async () => {
    const { helper } = makeHelper();
    await expect(helper.generateLLM(
      { provider: 'cloud', providerId: 'anthropic', modelId: 'sonnet-4.6' },
      'p',
    )).rejects.toThrow(/API key required/);
  });

  it('cloud: dispatches to anthropic on success', async () => {
    const { helper } = makeHelper();
    mockFetchOnce({ ok: true, body: { content: [{ text: 'anthropic-reply' }] } });
    const r = await helper.generateLLM(
      { provider: 'cloud', providerId: 'anthropic', modelId: 'sonnet-4.6' },
      'p',
      { apiKey: 'k' },
    );
    expect(r).toBe('anthropic-reply');
  });

  it('cloud: throws "Unknown cloud provider" on unrecognised providerId', async () => {
    const { helper } = makeHelper();
    await expect(helper.generateLLM(
      { provider: 'cloud', providerId: 'foo' as any, modelId: 'x' },
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

  it('synapseia: throws on version mismatch (expected vs active)', async () => {
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

// ── checkOllama / generateOllama passthroughs ─────────────────────────────
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
    expect(ollama.generate).toHaveBeenCalledWith('prompt', 'qwen');
  });
});
