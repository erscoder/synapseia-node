import { describe, it, expect } from '@jest/globals';
import { MoonshotAdapter } from '../moonshot.adapter';

const adapter = new MoonshotAdapter();

const SUCCESS_FIXTURE = {
  id: 'cmpl-1',
  object: 'chat.completion',
  created: 1730000000,
  model: 'kimi-k2.6',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Sure, here is the answer.' },
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
};

const REASONING_CONTENT_FIXTURE = {
  id: 'cmpl-2',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'Final answer: 42.',
        reasoning_content: 'I considered all the options and concluded that 42 is correct.',
      },
    },
  ],
  usage: { prompt_tokens: 18, completion_tokens: 23, total_tokens: 41 },
};

describe('MoonshotAdapter.buildRequest', () => {
  it('targets the moonshot.ai chat-completions endpoint', () => {
    const { url, init } = adapter.buildRequest({
      model: 'kimi-k2.6',
      prompt: 'hi',
      apiKey: 'sk-moonshot',
    });
    expect(url).toMatch(/moonshot\.ai\/v1\/chat\/completions$/);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-moonshot');
  });
});

describe('MoonshotAdapter.parseResponse', () => {
  it('extracts message.content', () => {
    const out = adapter.parseResponse(200, SUCCESS_FIXTURE);
    expect(out.text).toBe('Sure, here is the answer.');
    expect(out.finishReason).toBe('stop');
  });

  it('returns ONLY content even when reasoning_content is also present', () => {
    const out = adapter.parseResponse(200, REASONING_CONTENT_FIXTURE);
    expect(out.text).toBe('Final answer: 42.');
    expect(out.text).not.toMatch(/I considered/);
    expect(out.text).not.toMatch(/reasoning/i);
  });
});
