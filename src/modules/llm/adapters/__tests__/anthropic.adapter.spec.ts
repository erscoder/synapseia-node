import { describe, it, expect } from '@jest/globals';
import { AnthropicAdapter } from '../anthropic.adapter';

const adapter = new AnthropicAdapter();

const TEXT_ONLY_FIXTURE = {
  id: 'msg_01ABCD',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'Hello!' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4 },
};

const THINKING_PLUS_TEXT_FIXTURE = {
  id: 'msg_02XY',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [
    { type: 'thinking', thinking: 'Let me think about this...' },
    { type: 'text', text: 'Two plus two is four.' },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 9 },
};

const TOOL_USE_ONLY_FIXTURE = {
  id: 'msg_03ZZ',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [
    { type: 'tool_use', id: 'toolu_01', name: 'search', input: { q: 'foo' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 20, output_tokens: 5 },
};

describe('AnthropicAdapter.buildRequest', () => {
  it('sends to /v1/messages with anthropic-version header', () => {
    const { url, init } = adapter.buildRequest({
      model: 'claude-sonnet-4-6',
      prompt: 'hi',
      apiKey: 'sk-ant-test',
    });
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('AnthropicAdapter.parseResponse', () => {
  it('extracts the lone text block', () => {
    const out = adapter.parseResponse(200, TEXT_ONLY_FIXTURE);
    expect(out.text).toBe('Hello!');
    expect(out.finishReason).toBe('stop');
    expect(out.usage?.promptTokens).toBe(10);
    expect(out.usage?.completionTokens).toBe(4);
    expect(out.usage?.totalTokens).toBe(14);
  });

  it('skips thinking blocks and concatenates text blocks', () => {
    const out = adapter.parseResponse(200, THINKING_PLUS_TEXT_FIXTURE);
    expect(out.text).toBe('Two plus two is four.');
    expect(out.text).not.toMatch(/think/i);
  });

  it('throws when only tool_use blocks are returned', () => {
    expect(() => adapter.parseResponse(200, TOOL_USE_ONLY_FIXTURE)).toThrow(
      /no text blocks/i,
    );
  });

  it('maps stop_reason max_tokens → length', () => {
    const out = adapter.parseResponse(200, {
      ...TEXT_ONLY_FIXTURE,
      stop_reason: 'max_tokens',
    });
    expect(out.finishReason).toBe('length');
  });

  it('maps stop_reason refusal → content_filter', () => {
    const out = adapter.parseResponse(200, {
      ...TEXT_ONLY_FIXTURE,
      stop_reason: 'refusal',
    });
    expect(out.finishReason).toBe('content_filter');
  });
});

describe('AnthropicAdapter.parseError', () => {
  it('reads error.message from the standard envelope', () => {
    const e = adapter.parseError(400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages: at least one message is required' },
    });
    expect(e.message).toMatch(/at least one message/);
  });
});
