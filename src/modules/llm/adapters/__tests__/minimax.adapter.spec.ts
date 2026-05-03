import { describe, it, expect } from '@jest/globals';
import { MinimaxAdapter } from '../minimax.adapter';

const adapter = new MinimaxAdapter();

const SUCCESS_FIXTURE = {
  id: '02ee...',
  object: 'chat.completion',
  created: 1730000000,
  model: 'MiniMax-M2.7',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Hola, ¿en qué puedo ayudarte?' },
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  base_resp: { status_code: 0, status_msg: '' },
};

const APP_ERROR_2064_FIXTURE = {
  id: 'err-2064',
  base_resp: { status_code: 2064, status_msg: 'server cluster under high load' },
};

const APP_ERROR_1027_FIXTURE = {
  id: 'err-1027',
  base_resp: { status_code: 1027, status_msg: 'sensitive content blocked, please retry' },
};

const APP_ERROR_FATAL_FIXTURE = {
  id: 'err-1004',
  base_resp: { status_code: 1004, status_msg: 'rate limit exceeded' },
};

describe('MinimaxAdapter.parseResponse', () => {
  it('extracts content when base_resp.status_code is 0', () => {
    const out = adapter.parseResponse(200, SUCCESS_FIXTURE);
    expect(out.text).toBe('Hola, ¿en qué puedo ayudarte?');
    expect(out.finishReason).toBe('stop');
  });

  it('throws and tags transient when base_resp.status_code = 2064', () => {
    let err: Error | null = null;
    try {
      adapter.parseResponse(200, APP_ERROR_2064_FIXTURE);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/2064/);
    expect(adapter.isTransientError!(err)).toBe(true);
  });

  it('throws and tags transient for 1027 (temp content block)', () => {
    let err: Error | null = null;
    try {
      adapter.parseResponse(200, APP_ERROR_1027_FIXTURE);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(adapter.isTransientError!(err)).toBe(true);
  });

  it('throws and tags transient for 1004 (rate limit)', () => {
    let err: Error | null = null;
    try {
      adapter.parseResponse(200, APP_ERROR_FATAL_FIXTURE);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(adapter.isTransientError!(err)).toBe(true);
  });

  it('isTransientError returns false for unrelated errors', () => {
    expect(adapter.isTransientError!(new Error('Unauthorized'))).toBe(false);
  });
});
