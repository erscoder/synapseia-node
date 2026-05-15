/**
 * End-to-end round-trip coverage for LlmProviderHelper.generateLLM().
 *
 * For every cloud provider in the whitelist we fix `global.fetch` to
 * return a documented response payload (copied from the vendor's API
 * docs) and assert that:
 *   - the helper builds a request to the correct URL,
 *   - dispatches to the correct adapter,
 *   - extracts the assistant text correctly even when the schema has
 *     vendor-specific quirks (Anthropic block array, Gemini parts[],
 *     Moonshot reasoning_content, MiniMax base_resp),
 *   - applies `stripReasoning` to the final string.
 *
 * No real network calls are issued. The unit specs under
 * modules/llm/adapters/__tests__/ cover the shape parsing on its own;
 * this file glues the dispatcher + adapter + reasoning sanitiser
 * together to catch regressions at the seam.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LlmProviderHelper, type LLMModel } from '../modules/llm/llm-provider';

let mockCheckOllama: jest.Mock;
let mockGenerate: jest.Mock;
let mockPullModel: jest.Mock;

jest.mock('../modules/llm/ollama.js', () => {
  // Module factory cannot reference outer mutable state, so we wire the
  // mocks via prototype and re-bind them in the helper instance.
  class MockOllamaHelper {
    checkOllama = jest.fn();
    generate = jest.fn();
    pullModel = jest.fn();
  }
  return { OllamaHelper: MockOllamaHelper };
});

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  mockCheckOllama = jest.fn();
  mockGenerate = jest.fn();
  mockPullModel = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function freshHelper(): LlmProviderHelper {
  const helper = new LlmProviderHelper();
  (helper as unknown as {
    ollamaHelper: { checkOllama: jest.Mock; generate: jest.Mock; pullModel: jest.Mock };
  }).ollamaHelper = {
    checkOllama: mockCheckOllama,
    generate: mockGenerate,
    pullModel: mockPullModel,
  };
  return helper;
}

function fixedFetch(body: unknown, ok = true, status = 200): void {
  (global.fetch as unknown as jest.Mock).mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  });
}

const OLLAMA_MODEL: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };

describe('round-trip: Ollama', () => {
  it('returns mock content directly via OllamaHelper', async () => {
    mockGenerate.mockResolvedValue('local reply');
    const helper = freshHelper();
    expect(await helper.generateLLM(OLLAMA_MODEL, 'hi')).toBe('local reply');
  });

  it('strips <think> reasoning blocks from local output', async () => {
    mockGenerate.mockResolvedValue('<think>foo</think>real answer');
    const helper = freshHelper();
    const out = await helper.generateLLM(OLLAMA_MODEL, 'hi');
    expect(out).toContain('real answer');
    expect(out).not.toContain('<think>');
  });
});

describe('round-trip: OpenAI', () => {
  const model: LLMModel = { provider: 'cloud', providerId: 'openai', modelId: 'gpt-5' };

  it('extracts content from a documented OpenAI response', async () => {
    fixedFetch({
      id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-5',
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OpenAI says hi.' } },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
    });
    const helper = freshHelper();
    expect(await helper.generateLLM(model, 'hi', { apiKey: 'sk-test' })).toBe('OpenAI says hi.');
  });

  it('hits the official OpenAI URL with bearer auth', async () => {
    fixedFetch({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    });
    const helper = freshHelper();
    await helper.generateLLM(model, 'hi', { apiKey: 'sk-test' });
    const fetchMock = global.fetch as unknown as jest.Mock;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
  });
});

describe('round-trip: Anthropic', () => {
  const model: LLMModel = { provider: 'cloud', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' };

  it('returns concatenated text blocks from /v1/messages', async () => {
    fixedFetch({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Anthropic ' }, { type: 'text', text: 'response' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const helper = freshHelper();
    expect(await helper.generateLLM(model, 'hi', { apiKey: 'k' })).toBe('Anthropic response');
  });

  it('drops thinking blocks before stripReasoning runs', async () => {
    fixedFetch({
      content: [
        { type: 'thinking', thinking: 'Hmm let me think.' },
        { type: 'text', text: 'Final.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const helper = freshHelper();
    const out = await helper.generateLLM(model, 'hi', { apiKey: 'k' });
    expect(out).toBe('Final.');
    expect(out).not.toMatch(/Hmm/);
  });
});

describe('round-trip: Google (Gemini)', () => {
  const model: LLMModel = { provider: 'cloud', providerId: 'google', modelId: 'gemini-2.5-pro' };

  it('extracts from candidates[0].content.parts[0].text', async () => {
    fixedFetch({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Bonjour.' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });
    const helper = freshHelper();
    expect(await helper.generateLLM(model, 'hi', { apiKey: 'g-key' })).toBe('Bonjour.');
  });

  it('embeds the model in the URL path', async () => {
    fixedFetch({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    });
    const helper = freshHelper();
    await helper.generateLLM(model, 'hi', { apiKey: 'g-key' });
    const fetchMock = global.fetch as unknown as jest.Mock;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/models\/gemini-2\.5-pro:generateContent$/);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
  });
});

describe('round-trip: Moonshot (Kimi)', () => {
  const model: LLMModel = { provider: 'cloud', providerId: 'moonshot', modelId: 'kimi-k2.6' };

  it('extracts choices[0].message.content (ignoring reasoning_content)', async () => {
    fixedFetch({
      id: 'cmpl-k',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Kimi reply.',
            reasoning_content: 'thinking out loud, should not leak',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const helper = freshHelper();
    const out = await helper.generateLLM(model, 'hi', { apiKey: 'mk' });
    expect(out).toBe('Kimi reply.');
    expect(out).not.toMatch(/thinking out loud/);
  });
});

describe('round-trip: MiniMax', () => {
  const model: LLMModel = { provider: 'cloud', providerId: 'minimax', modelId: 'MiniMax-M2.7' };

  it('returns content when base_resp.status_code is 0', async () => {
    fixedFetch({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hola' } }],
      base_resp: { status_code: 0, status_msg: '' },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const helper = freshHelper();
    expect(await helper.generateLLM(model, 'hi', { apiKey: 'mm' })).toBe('Hola');
  });

  it('does NOT retry hard application errors (1008 unauthorized = fatal)', async () => {
    fixedFetch({ base_resp: { status_code: 1008, status_msg: 'unauthorized' } });
    const helper = freshHelper();
    await expect(
      helper.generateLLM(model, 'hi', { apiKey: 'bad' }),
    ).rejects.toThrow(/base_resp 1008/);
    // 1 attempt, no retries (1008 is not in the transient set).
    const fetchMock = global.fetch as unknown as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 2064 (high load) once then succeeds', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = global.fetch as unknown as jest.Mock;
      fetchMock
        .mockResolvedValueOnce({
          ok: true, status: 200, statusText: 'OK',
          text: async () => JSON.stringify({ base_resp: { status_code: 2064, status_msg: 'high load' } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200, statusText: 'OK',
          text: async () =>
            JSON.stringify({
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'finally' } }],
              base_resp: { status_code: 0, status_msg: '' },
            }),
        });
      const helper = freshHelper();
      const promise = helper.generateLLM(model, 'hi', { apiKey: 'mm' });
      await jest.advanceTimersByTimeAsync(1100);
      await expect(promise).resolves.toBe('finally');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });
});

describe('round-trip: Zhipu (GLM)', () => {
  const model: LLMModel = { provider: 'cloud', providerId: 'zhipu', modelId: 'glm-4.6' };

  it('extracts content from the standard OpenAI envelope', async () => {
    fixedFetch({
      id: 'glm-1',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Salut.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const helper = freshHelper();
    expect(await helper.generateLLM(model, 'hi', { apiKey: 'z-key' })).toBe('Salut.');
  });

  it('routes to bigmodel.cn', async () => {
    fixedFetch({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    });
    const helper = freshHelper();
    await helper.generateLLM(model, 'hi', { apiKey: 'z-key' });
    const fetchMock = global.fetch as unknown as jest.Mock;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });
});

/**
 * Auto-pull retry path: when Ollama returns "model not found", the
 * helper should `pullModel(name)` once and retry generate. Anything
 * else (transient errors, second-attempt failures, pull failures)
 * must propagate without looping.
 *
 * Pulling on every transient outage would amplify pressure on the
 * Ollama daemon and burn pod bandwidth; the auto-pull is strictly
 * for "operator told us to use model X, but X isn't pulled yet".
 */
describe('Ollama auto-pull retry', () => {
  const MISSING_ERROR_MSG = "Generation failed: model 'qwen2.5-coder:7b' not found";

  it('pulls the model and retries generate when Ollama returns model-not-found', async () => {
    mockGenerate
      .mockRejectedValueOnce(new Error(MISSING_ERROR_MSG))
      .mockResolvedValueOnce('plan: do the thing');
    mockPullModel.mockResolvedValueOnce(undefined);

    const helper = freshHelper();
    const result = await helper.generateLLM(OLLAMA_MODEL, 'hi');

    expect(result).toBe('plan: do the thing');
    expect(mockPullModel).toHaveBeenCalledTimes(1);
    expect(mockPullModel).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('propagates the original error if auto-pull itself fails', async () => {
    mockGenerate.mockRejectedValue(new Error(MISSING_ERROR_MSG));
    mockPullModel.mockRejectedValueOnce(new Error('network unreachable'));

    const helper = freshHelper();
    await expect(helper.generateLLM(OLLAMA_MODEL, 'hi')).rejects.toThrow(
      /model 'qwen2.5-coder:7b' not found/,
    );
    expect(mockPullModel).toHaveBeenCalledTimes(1);
    // Generate is only invoked once when the auto-pull throws — we
    // never reach the retry.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('does NOT attempt auto-pull on transient errors (timeout, runner crash, etc.)', async () => {
    // "runner process no longer running" is a known transient classified
    // by isTransientLlmError; the outer retry loop will handle it. The
    // inner generateOllamaLLM must not also try to pull, otherwise a
    // crash-loop would yank the model file mid-cascade.
    mockGenerate.mockRejectedValue(new Error('Generation failed: runner process no longer running'));

    const helper = freshHelper();
    await expect(helper.generateLLM(OLLAMA_MODEL, 'hi')).rejects.toThrow(/runner process/);
    expect(mockPullModel).not.toHaveBeenCalled();
  });

  it('does NOT attempt auto-pull when retry after pull fails too (propagates second error)', async () => {
    // Pull succeeded but the second generate still fails — propagate.
    // We must NOT loop into a third pull. The error from the second
    // attempt is the one operators need to debug.
    mockGenerate
      .mockRejectedValueOnce(new Error(MISSING_ERROR_MSG))
      .mockRejectedValueOnce(new Error('Generation failed: out of memory'));
    mockPullModel.mockResolvedValueOnce(undefined);

    const helper = freshHelper();
    await expect(helper.generateLLM(OLLAMA_MODEL, 'hi')).rejects.toThrow(/out of memory/);
    expect(mockPullModel).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});
