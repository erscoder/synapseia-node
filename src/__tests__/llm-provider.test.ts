import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  LlmProviderHelper,
  SUPPORTED_MODELS,
  MODEL_METADATA,
  type LLMModel,
} from '../modules/llm/llm-provider';

var mockCheckOllama: any = jest.fn();
var mockGenerate: any = jest.fn();

jest.mock('../modules/llm/ollama.js', () => {
  class MockOllamaHelper {
    checkOllama = mockCheckOllama;
    generate = mockGenerate;
  }
  MockOllamaHelper.prototype.checkOllama = mockCheckOllama;
  MockOllamaHelper.prototype.generate = mockGenerate;
  return { OllamaHelper: MockOllamaHelper };
});

global.fetch = jest.fn() as any;

describe('LlmProviderHelper', () => {
  let helper: LlmProviderHelper;
  const ollamaModel: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };
  const anthropicModel: LLMModel = { provider: 'cloud', providerId: 'anthropic', modelId: 'sonnet-4.6' };
  const kimiModel: LLMModel = { provider: 'cloud', providerId: 'moonshot', modelId: 'kimi-k2.5' };
  const minimaxModel: LLMModel = { provider: 'cloud', providerId: 'minimax', modelId: 'MiniMax-M2.7' };

  beforeEach(() => {
    jest.clearAllMocks();
    helper = new LlmProviderHelper();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('parseModel', () => {
    it('should parse valid Ollama models', () => {
      expect(helper.parseModel('ollama/qwen2.5:0.5b')).toEqual({
        provider: 'ollama',
        providerId: '',
        modelId: 'qwen2.5:0.5b',
      });
      expect(helper.parseModel('ollama/gemma3:4b')).toEqual({
        provider: 'ollama',
        providerId: '',
        modelId: 'gemma3:4b',
      });
    });

    it('should parse valid Cloud models', () => {
      expect(helper.parseModel('anthropic/sonnet-4.6')).toEqual({
        provider: 'cloud',
        providerId: 'anthropic',
        modelId: 'sonnet-4.6',
      });
      expect(helper.parseModel('kimi/k2.5')).toEqual({
        provider: 'cloud',
        providerId: 'moonshot',
        modelId: 'kimi-k2.5',
      });
    });

    it('should return null for invalid models', () => {
      expect(helper.parseModel('invalid/model')).toBeNull();
      expect(helper.parseModel('')).toBeNull();
    });
  });

  describe('getOptionalString', () => {
    it('should return string when valid object with string property', () => {
      const obj: any = { error: { message: 'Test error' } };
      expect(helper.getOptionalString(obj.error, 'message')).toBe('Test error');
    });

    it('should return undefined when object is null', () => {
      expect(helper.getOptionalString(null as { message?: string } | null, 'message')).toBeUndefined();
    });

    it('should return undefined when object is undefined', () => {
      expect(helper.getOptionalString(undefined as { message?: string } | undefined, 'message')).toBeUndefined();
    });

    it('should return undefined when property is not a string', () => {
      const obj: any = { error: { message: 123 as any } };
      expect(helper.getOptionalString(obj.error, 'message')).toBeUndefined();
    });

    it('should return undefined when property does not exist', () => {
      const obj: any = { error: {} };
      expect(helper.getOptionalString(obj.error, 'message')).toBeUndefined();
    });
  });

  describe('toErrorMessage', () => {
    it('should return message from Error object', () => {
      const error = new Error('Test error message');
      expect(helper.toErrorMessage(error)).toBe('Test error message');
    });

    it('should return "Unknown error" for string', () => {
      expect(helper.toErrorMessage('String error')).toBe('Unknown error');
    });

    it('should return "Unknown error" for object without message', () => {
      expect(helper.toErrorMessage({ code: 500 })).toBe('Unknown error');
    });

    it('should return "Unknown error" for null', () => {
      expect(helper.toErrorMessage(null)).toBe('Unknown error');
    });

    it('should return "Unknown error" for undefined', () => {
      expect(helper.toErrorMessage(undefined)).toBe('Unknown error');
    });
  });

  describe('SUPPORTED_MODELS', () => {
    it('should have all required models', () => {
      expect(SUPPORTED_MODELS['ollama/qwen2.5:0.5b']).toBeDefined();
      expect(SUPPORTED_MODELS['ollama/qwen2.5:3b']).toBeDefined();
      expect(SUPPORTED_MODELS['ollama/gemma3:4b']).toBeDefined();
      expect(SUPPORTED_MODELS['ollama/llama3.2:3b']).toBeDefined();
      expect(SUPPORTED_MODELS['anthropic/sonnet-4.6']).toBeDefined();
      expect(SUPPORTED_MODELS['kimi/k2.5']).toBeDefined();
      expect(SUPPORTED_MODELS['minimax/MiniMax-M2.7']).toBeDefined();
    });
  });

  describe('MODEL_METADATA', () => {
    it('should have metadata for all models', () => {
      expect(MODEL_METADATA['qwen2.5:0.5b']).toBeDefined();
      expect(MODEL_METADATA['sonnet-4.6']).toBeDefined();
      expect(MODEL_METADATA['kimi-k2.5']).toBeDefined();
      expect(MODEL_METADATA['MiniMax-M2.7']).toBeDefined();
    });

    it('should have cost only for cloud models', () => {
      const ollamaMeta = MODEL_METADATA['qwen2.5:0.5b'] as any;
      const anthropicMeta = MODEL_METADATA['sonnet-4.6'] as any;
      const kimiMeta = MODEL_METADATA['kimi-k2.5'] as any;
      expect(ollamaMeta.costPerCall).toBeUndefined();
      expect(anthropicMeta.costPerCall).toBe(0.003);
      expect(kimiMeta.costPerCall).toBe(0.002);
    });
  });

  describe('checkLLM - Ollama', () => {
    it('should return available status when Ollama is running and model exists', async () => {
      mockCheckOllama.mockResolvedValue({
        available: true,
        url: 'http://localhost:11434',
        models: ['qwen2.5:0.5b', 'qwen2.5:3b'],
        recommendedModel: 'qwen2.5:0.5b',
      });
      const status = await helper.checkLLM(ollamaModel);
      expect(status.available).toBe(true);
      expect(status.model).toEqual(ollamaModel);
      expect(status.error).toBeUndefined();
    });

    it('should return unavailable status when Ollama is not running', async () => {
      mockCheckOllama.mockResolvedValue({
        available: false,
        url: 'http://localhost:11434',
        models: [],
        recommendedModel: 'qwen2.5:0.5b',
        error: 'ECONNREFUSED',
      });
      const status = await helper.checkLLM(ollamaModel);
      expect(status.available).toBe(false);
      expect(status.error).toContain('ECONNREFUSED');
    });
  });

  describe('checkLLM - Cloud (Anthropic)', () => {
    it('should return unavailable when API key missing', async () => {
      const status = await helper.checkLLM(anthropicModel);
      expect(status.available).toBe(false);
      expect(status.error).toContain('API key');
    });

    it('should return available when API key is provided', async () => {
      (global.fetch as any).mockResolvedValue({ ok: true });
      const status = await helper.checkLLM(anthropicModel, { apiKey: 'test-key' });
      expect(status.available).toBe(true);
      expect(status.model).toEqual(anthropicModel);
    });
  });

  describe('generateLLM - Ollama', () => {
    it('should generate text from Ollama model', async () => {
      mockGenerate.mockResolvedValue('Test generated text');
      const result = await helper.generateLLM(ollamaModel, 'Hello world');
      expect(result).toBe('Test generated text');
    });

    it('should handle Ollama errors', async () => {
      mockGenerate.mockRejectedValue(new Error('Ollama error'));
      await expect(helper.generateLLM(ollamaModel, 'test')).rejects.toThrow('Ollama error');
    });
  });

  describe('generateLLM - Cloud (Anthropic)', () => {
    it('should generate text from Anthropic model', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Anthropic response' }],
          stop_reason: 'end_turn',
        }),
      });
      const result = await helper.generateLLM(anthropicModel, 'Hello', { apiKey: 'test-key' });
      expect(result).toBe('Anthropic response');
    });
  });

  describe('generateLLM - Cloud (Moonshot/Kimi)', () => {
    it('should generate text from Kimi model', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Kimi response' }, finish_reason: 'stop' }],
        }),
      });
      const result = await helper.generateLLM(kimiModel, 'Hello', { apiKey: 'test-key' });
      expect(result).toBe('Kimi response');
    });
  });

  describe('generateLLM - Cloud (MiniMax)', () => {
    it('should generate text from MiniMax model', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'MiniMax response' }, finish_reason: 'stop' }],
        }),
      });
      const result = await helper.generateLLM(minimaxModel, 'Hello', { apiKey: 'test-key' });
      expect(result).toBe('MiniMax response');
    });
  });
});
