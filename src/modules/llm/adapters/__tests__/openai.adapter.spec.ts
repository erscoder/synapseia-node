import { describe, it, expect } from '@jest/globals';
import { OpenAIAdapter } from '../openai.adapter';

const adapter = new OpenAIAdapter();

const SUCCESS_FIXTURE = {
  id: 'chatcmpl-9abc',
  object: 'chat.completion',
  created: 1730000000,
  model: 'gpt-5',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Hello, how can I help you?' },
    },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
};

describe('OpenAIAdapter.buildRequest', () => {
  it('targets the official chat-completions endpoint', () => {
    const { url, init } = adapter.buildRequest({
      model: 'gpt-5',
      prompt: 'hi',
      apiKey: 'sk-test',
    });
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('passes hyperparams + forceJson when provided', () => {
    const { init } = adapter.buildRequest({
      model: 'gpt-4o',
      prompt: 'json please',
      apiKey: 'sk-test',
      hyperparams: { temperature: 0.5, maxTokens: 1024, forceJson: true },
    });
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(1024);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('OpenAIAdapter.parseResponse', () => {
  it('extracts message.content from a textbook response', () => {
    const out = adapter.parseResponse(200, SUCCESS_FIXTURE);
    expect(out.text).toBe('Hello, how can I help you?');
    expect(out.finishReason).toBe('stop');
    expect(out.usage).toEqual({ promptTokens: 9, completionTokens: 7, totalTokens: 16 });
  });

  it('maps finish_reason length / content_filter / tool_calls', () => {
    for (const [vendor, expected] of [
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['tool_calls', 'tool_calls'],
      ['function_call', 'tool_calls'],
    ] as const) {
      const out = adapter.parseResponse(200, {
        choices: [{ index: 0, finish_reason: vendor, message: { role: 'assistant', content: 'x' } }],
      });
      expect(out.finishReason).toBe(expected);
    }
  });

  it('throws when message.content is null with tool_calls', () => {
    expect(() =>
      adapter.parseResponse(200, {
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] } }],
      }),
    ).toThrow(/no message\.content/i);
  });

  it('throws when assistant emitted a refusal', () => {
    expect(() =>
      adapter.parseResponse(200, {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' },
          },
        ],
      }),
    ).toThrow(/refused/i);
  });

  it('throws on empty choices array', () => {
    expect(() => adapter.parseResponse(200, { choices: [] })).toThrow(/no choices/);
  });
});

describe('OpenAIAdapter.parseError', () => {
  it('reads error.message', () => {
    const e = adapter.parseError(401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } });
    expect(e.message).toMatch(/Invalid API key/);
  });

  it('falls back to status text when body is empty', () => {
    const e = adapter.parseError(500, null, '<html>internal error</html>');
    expect(e.message).toMatch(/HTTP 500/);
  });
});
