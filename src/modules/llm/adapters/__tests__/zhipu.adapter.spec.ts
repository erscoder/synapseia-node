import { describe, it, expect } from '@jest/globals';
import { ZhipuAdapter } from '../zhipu.adapter';

const adapter = new ZhipuAdapter();

const SUCCESS_FIXTURE = {
  id: 'glm-4.6-001',
  object: 'chat.completion',
  created: 1730000000,
  model: 'glm-4.6',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Bonjour, comment puis-je vous aider ?' },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 },
};

describe('ZhipuAdapter.buildRequest', () => {
  it('targets bigmodel.cn /api/paas/v4/chat/completions', () => {
    const { url } = adapter.buildRequest({
      model: 'glm-4.6',
      prompt: 'hola',
      apiKey: 'zhipu-key',
    });
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });
});

describe('ZhipuAdapter.parseResponse', () => {
  it('extracts message.content', () => {
    const out = adapter.parseResponse(200, SUCCESS_FIXTURE);
    expect(out.text).toBe('Bonjour, comment puis-je vous aider ?');
    expect(out.finishReason).toBe('stop');
    expect(out.usage?.totalTokens).toBe(19);
  });
});

describe('ZhipuAdapter.parseError', () => {
  it('reads error.message', () => {
    const e = adapter.parseError(401, { error: { code: 'invalid_api_key', message: 'API key invalid' } });
    expect(e.message).toMatch(/API key invalid/);
  });
});
