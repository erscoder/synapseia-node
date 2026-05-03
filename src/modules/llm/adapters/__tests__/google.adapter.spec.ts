import { describe, it, expect } from '@jest/globals';
import { GoogleAdapter } from '../google.adapter';

const adapter = new GoogleAdapter();

const SUCCESS_FIXTURE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'The capital of France is Paris.' }],
      },
      finishReason: 'STOP',
      safetyRatings: [],
    },
  ],
  usageMetadata: {
    promptTokenCount: 8,
    candidatesTokenCount: 7,
    totalTokenCount: 15,
  },
};

const THOUGHT_PLUS_TEXT_FIXTURE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          { thought: true, text: 'Reasoning: Paris is in France...' },
          { text: 'Paris.' },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
};

const FUNCTION_CALL_ONLY_FIXTURE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'search', args: { q: 'foo' } } }],
      },
      finishReason: 'TOOL_CODE_FAILURE',
    },
  ],
};

const PROMPT_BLOCKED_FIXTURE = {
  promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] },
};

describe('GoogleAdapter.buildRequest', () => {
  it('embeds the model in the URL path and uses x-goog-api-key header', () => {
    const { url, init } = adapter.buildRequest({
      model: 'gemini-2.5-pro',
      prompt: 'hi',
      apiKey: 'my-google-key',
    });
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('my-google-key');
    expect(url).not.toMatch(/[?&]key=/); // never put key in querystring
  });

  it('translates hyperparams + forceJson into generationConfig', () => {
    const { init } = adapter.buildRequest({
      model: 'gemini-2.5-flash',
      prompt: 'json now',
      apiKey: 'k',
      hyperparams: { temperature: 0.2, maxTokens: 512, forceJson: true },
    });
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
    });
  });
});

describe('GoogleAdapter.parseResponse', () => {
  it('extracts text from candidates[0].content.parts', () => {
    const out = adapter.parseResponse(200, SUCCESS_FIXTURE);
    expect(out.text).toBe('The capital of France is Paris.');
    expect(out.finishReason).toBe('stop');
    expect(out.usage).toEqual({ promptTokens: 8, completionTokens: 7, totalTokens: 15 });
  });

  it('skips parts with thought:true and concatenates only non-thought text', () => {
    const out = adapter.parseResponse(200, THOUGHT_PLUS_TEXT_FIXTURE);
    expect(out.text).toBe('Paris.');
    expect(out.text).not.toMatch(/Reasoning/);
  });

  it('throws when promptFeedback.blockReason is set', () => {
    expect(() => adapter.parseResponse(200, PROMPT_BLOCKED_FIXTURE)).toThrow(/blockReason=SAFETY/);
  });

  it('throws when only functionCall parts come back', () => {
    expect(() => adapter.parseResponse(200, FUNCTION_CALL_ONLY_FIXTURE)).toThrow(/no text parts/i);
  });

  it('maps SAFETY → content_filter', () => {
    const out = adapter.parseResponse(200, {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: '...' }] },
          finishReason: 'SAFETY',
        },
      ],
    });
    expect(out.finishReason).toBe('content_filter');
  });
});

describe('GoogleAdapter.parseError', () => {
  it('reads error.message from the Google envelope', () => {
    const e = adapter.parseError(400, {
      error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' },
    });
    expect(e.message).toMatch(/API key not valid/);
  });
});
