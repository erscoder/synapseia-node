import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  parseModel,
  SUPPORTED_MODELS,
  MODEL_METADATA,
  checkLLM,
  generateLLM,
  getOptionalString,
  toErrorMessage,
  type LLMModel,
} from '../modules/llm/llm-provider';

// Mock ollama module
jest.mock('../modules/llm/ollama.js', () => ({
  checkOllama: jest.fn(),
  generate: jest.fn(),
}));

// Mock fetch for cloud APIs
global.fetch = jest.fn() as any;

import { checkOllama, generate as generateOllama } from '../modules/llm/ollama.js';

describe('LLM Provider Abstraction', () => {
  const ollamaModel: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };
  const anthropicModel: LLMModel = { provider: 'cloud', providerId: 'anthropic', modelId: 'sonnet-4.6' };
  const kimiModel: LLMModel = { provider: 'cloud', providerId: 'moonshot', modelId: 'kimi-k2.5' };
  const minimaxModel: LLMModel = { provider: 'cloud', providerId: 'minimax', modelId: 'MiniMax-M2.7' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('parseModel', () => {
    it('should parse valid Ollama models', () => {
      expect(parseModel('ollama/qwen2.5:0.5b')).toEqual({
        provider: 'ollama',
        providerId: '',
        modelId: 'qwen2.5:0.5b',
      });
      expect(parseModel('ollama/gemma3:4b')).toEqual({
        provider: 'ollama',
        providerId: '',
        modelId: 'gemma3:4b',
      });
    });

    it('should parse valid Cloud models', () => {
      expect(parseModel('anthropic/sonnet-4.6')).toEqual({
        provider: 'cloud',
        providerId: 'anthropic',
        modelId: 'sonnet-4.6',
      });
      expect(parseModel('kimi/k2.5')).toEqual({
        provider: 'cloud',
        providerId: 'moonshot',
        modelId: 'kimi-k2.5',
      });
    });

    it('should return null for invalid models', () => {
      expect(parseModel('invalid/model')).toBeNull();
      expect(parseModel('')).toBeNull();
    });
  });

  describe('getOptionalString helper', () => {
    it('should return string when valid object with string property', () => {
      const obj: any = { error: { message: 'Test error' } };
      expect(getOptionalString(obj.error, 'message')).toBe('Test error');
    });

    it('should return undefined when object is null', () => {
      expect(getOptionalString(null, 'message')).toBeUndefined();
    });

    it('should return undefined when object is undefined', () => {
      expect(getOptionalString(undefined, 'message')).toBeUndefined();
    });

    it('should return undefined when property is not a string', () => {
      const obj: any = { error: { message: 123 as any } };
      expect(getOptionalString(obj.error, 'message')).toBeUndefined();
    });

    it('should return undefined when property does not exist', () => {
      const obj: any = { error: {} };
      expect(getOptionalString(obj.error, 'message')).toBeUndefined();
    });
  });

  describe('toErrorMessage helper', () => {
    it('should return message from Error object', () => {
      const error = new Error('Test error message');
      expect(toErrorMessage(error)).toBe('Test error message');
    });

    it('should return "Unknown error" for string', () => {
      expect(toErrorMessage('String error')).toBe('Unknown error');
    });

    it('should return "Unknown error" for object without message', () => {
      expect(toErrorMessage({ code: 500 })).toBe('Unknown error');
    });

    it('should return "Unknown error" for null', () => {
      expect(toErrorMessage(null)).toBe('Unknown error');
    });

    it('should return "Unknown error" for undefined', () => {
      expect(toErrorMessage(undefined)).toBe('Unknown error');
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
      (checkOllama as jest.Mock).mockResolvedValue({
        available: true,
        url: 'http://localhost:11434',
        models: ['qwen2.5:0.5b', 'qwen2.5:3b'],
        recommendedModel: 'qwen2.5:0.5b',
      });

      const status = await checkLLM(ollamaModel);

      expect(status.available).toBe(true);
      expect(status.model).toEqual(ollamaModel);
      expect(status.estimatedLatencyMs).toBe(300);
      expect(status.maxTokens).toBe(4096);
      expect(status.error).toBeUndefined();
    });

    it('should return unavailable status when Ollama is not running', async () => {
      (checkOllama as jest.Mock).mockResolvedValue({
        available: false,
        url: 'http://localhost:11434',
        models: [],
        recommendedModel: 'qwen2.5:0.5b',
        error: 'ECONNREFUSED',
      });

      const status = await checkLLM(ollamaModel);

      expect(status.available).toBe(false);
      expect(status.model).toEqual(ollamaModel);
      expect(status.estimatedLatencyMs).toBe(0);
      expect(status.error).toBe('ECONNREFUSED');
    });

    it('should return unavailable status when model not found', async () => {
      (checkOllama as jest.Mock).mockResolvedValue({
        available: true,
        url: 'http://localhost:11434',
        models: ['qwen2.5:3b'], // Model not present
        recommendedModel: 'qwen2.5:0.5b',
      });

      const status = await checkLLM(ollamaModel);

      expect(status.available).toBe(false);
      expect(status.error).toContain('not found');
      expect(status.error).toContain('ollama pull');
    });

    it('should handle checkOllama errors', async () => {
      (checkOllama as jest.Mock).mockImplementation(async () => {
        throw new Error('Check failed');
      });

      const status = await checkLLM(ollamaModel);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Check failed');
    });

    it('should handle checkOllama with non-Error rejection', async () => {
      (checkOllama as jest.Mock).mockImplementation(async () => {
        throw 'String error from Ollama';
      });

      const status = await checkLLM(ollamaModel);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });

    it('should handle checkOllama with object rejection', async () => {
      (checkOllama as jest.Mock).mockImplementation(async () => {
        throw { code: 'ECONNREFUSED' };
      });

      const status = await checkLLM(ollamaModel);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });
  });

  describe('generateLLM - Ollama', () => {
    it('should generate text with Ollama model', async () => {
      (generateOllama as jest.Mock).mockResolvedValue('Generated response');

      const result = await generateLLM(ollamaModel, 'Test prompt');

      expect(result).toBe('Generated response');
      expect(generateOllama).toHaveBeenCalledWith('Test prompt', 'qwen2.5:0.5b', undefined, undefined);
    });

    it('should throw error when Ollama generation fails', async () => {
      (generateOllama as jest.Mock).mockRejectedValue(new Error('Generation failed'));

      await expect(generateLLM(ollamaModel, 'Test')).rejects.toThrow('Generation failed');
    });
  });

  describe('checkLLM - Cloud Anthropic', () => {
    it('should return available status when API key is valid', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ text: 'Hi' }] }),
      } as any);

      const status = await checkLLM(anthropicModel, { apiKey: 'test-key' });

      expect(status.available).toBe(true);
      expect(status.estimatedLatencyMs).toBe(200);
      expect(status.estimatedCostPerCall).toBe(0.003);
      expect(status.maxTokens).toBe(200000);
    });

    it('should return unavailable status when API key is missing', async () => {
      const status = await checkLLM(anthropicModel);

      expect(status.available).toBe(false);
      expect(status.error).toBe('API key required for cloud provider');
    });

    it('should return unavailable status when API returns error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid API key' } }),
      } as any);

      const status = await checkLLM(anthropicModel, { apiKey: 'invalid-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Invalid API key');
    });

    it('should handle network errors', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const status = await checkLLM(anthropicModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Network error');
    });

    it('should handle non-Error errors in catch', async () => {
      (global.fetch as jest.Mock).mockRejectedValue('String error');

      const status = await checkLLM(anthropicModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });

    it('should handle object errors without message property', async () => {
      (global.fetch as jest.Mock).mockRejectedValue({ code: 500 });

      const status = await checkLLM(anthropicModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });
  });

  describe('generateLLM - Cloud Anthropic', () => {
    it('should generate text with Anthropic API', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ text: 'Anthropic response' }] }),
      } as any);

      const result = await generateLLM(anthropicModel, 'Test prompt', { apiKey: 'test-key' });

      expect(result).toBe('Anthropic response');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'test-key',
            'anthropic-version': '2023-06-01',
          }),
        })
      );
    });

    it('should throw error when API key is missing', async () => {
      await expect(generateLLM(anthropicModel, 'Test')).rejects.toThrow('API key required for cloud provider');
    });

    it('should throw error when API returns error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: 'Rate limit exceeded' } }),
      } as any);

      await expect(generateLLM(anthropicModel, 'Test', { apiKey: 'test-key' })).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('checkLLM - Cloud Moonshot', () => {
    it('should return available status when API key is valid', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Hi' } }] }),
      } as any);

      const status = await checkLLM(kimiModel, { apiKey: 'test-key' });

      expect(status.available).toBe(true);
      expect(status.estimatedLatencyMs).toBe(300);
      expect(status.estimatedCostPerCall).toBe(0.002);
      expect(status.maxTokens).toBe(131072);
    });

    it('should return unavailable status when API returns error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: 'Unauthorized' } }),
      } as any);

      const status = await checkLLM(kimiModel, { apiKey: 'invalid-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unauthorized');
    });

    it('should handle network errors', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const status = await checkLLM(kimiModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Network error');
    });

    it('should handle non-Error errors in catch', async () => {
      (global.fetch as jest.Mock).mockRejectedValue('String error');

      const status = await checkLLM(kimiModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });

    it('should handle object errors without message property', async () => {
      (global.fetch as jest.Mock).mockRejectedValue({ code: 500 });

      const status = await checkLLM(kimiModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });
  });

  describe('generateLLM - Cloud Moonshot', () => {
    it('should generate text with Moonshot API', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Moonshot response' } }] }),
      } as any);

      const result = await generateLLM(kimiModel, 'Test prompt', { apiKey: 'test-key' });

      expect(result).toBe('Moonshot response');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.moonshot.cn/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
          }),
        })
      );
    });

    it('should throw error when API key is missing', async () => {
      await expect(generateLLM(kimiModel, 'Test')).rejects.toThrow('API key required for cloud provider');
    });

    it('should throw error when API returns error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        statusText: 'Rate limit exceeded',
        json: async () => ({ error: { message: 'Rate limit' } }),
      } as any);

      await expect(generateLLM(kimiModel, 'Test', { apiKey: 'test-key' })).rejects.toThrow('Rate limit');
    });
  });

  describe('checkLLM - Cloud Minimax', () => {
    it('should return available status when API key is valid', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Hi' } }] }),
      } as any);

      const status = await checkLLM(minimaxModel, { apiKey: 'test-key' });

      expect(status.available).toBe(true);
      expect(status.estimatedLatencyMs).toBe(250);
      expect(status.estimatedCostPerCall).toBe(0.0015);
      expect(status.maxTokens).toBe(131072);
    });

    it('should return unavailable status when API returns error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: 'Invalid request' } }),
      } as any);

      const status = await checkLLM(minimaxModel, { apiKey: 'invalid-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Invalid request');
    });

    it('should handle network errors', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const status = await checkLLM(minimaxModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Network error');
    });

    it('should handle non-Error errors in catch', async () => {
      (global.fetch as jest.Mock).mockRejectedValue('String error');

      const status = await checkLLM(minimaxModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });

    it('should handle object errors without message property', async () => {
      (global.fetch as jest.Mock).mockRejectedValue({ code: 500 });

      const status = await checkLLM(minimaxModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });
  });

  describe('generateLLM - Cloud Minimax', () => {
    it('should generate text with Minimax default URL', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Minimax response' } }] }),
      } as any);

      const result = await generateLLM(minimaxModel, 'Test prompt', { apiKey: 'test-key' });

      expect(result).toBe('Minimax response');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.minimax.io/v1/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
          }),
        })
      );
    });

    it('should generate text with custom Minimax URL', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Custom response' } }] }),
      } as any);

      const result = await generateLLM(minimaxModel, 'Test prompt', {
        apiKey: 'test-key',
        baseUrl: 'https://custom.api.com/v1/chat',
      });

      expect(result).toBe('Custom response');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom.api.com/v1/chat',
        expect.any(Object)
      );
    });

    it('should throw error when API key is missing', async () => {
      await expect(generateLLM(minimaxModel, 'Test')).rejects.toThrow('API key required for cloud provider');
    });

    it('should throw error when API returns error with message', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        statusText: 'Gateway Timeout',
        json: async () => ({ error: { message: 'Server error' } }),
      } as any);

      await expect(generateLLM(minimaxModel, 'Test', { apiKey: 'test-key' })).rejects.toThrow('Server error');
    });

    it('should throw error when API returns statusText only', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        statusText: 'Gateway Timeout',
        json: async () => ({}),
      } as any);

      await expect(generateLLM(minimaxModel, 'Test', { apiKey: 'test-key' })).rejects.toThrow('Gateway Timeout');
    });
  });

  describe('Unknown provider errors', () => {
    it('should return unavailable status for unknown provider in check', async () => {
      const unknownModel: LLMModel = { provider: 'unknown' as any, providerId: '', modelId: 'test' };
      const status = await checkLLM(unknownModel);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown provider');
    });

    it('should throw error for unknown provider in generate', async () => {
      const unknownModel: LLMModel = { provider: 'unknown' as any, providerId: '', modelId: 'test' };

      await expect(generateLLM(unknownModel, 'Test')).rejects.toThrow('Unknown provider');
    });
  });

  describe('Unknown cloud provider errors', () => {
    it('should return unavailable status for unknown cloud provider in check', async () => {
      const unknownModel: LLMModel = { provider: 'cloud', providerId: 'unknown' as any, modelId: 'test' };
      const status = await checkLLM(unknownModel, { apiKey: 'test-key' });

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown cloud provider');
    });

    it('should throw error for unknown cloud provider in generate', async () => {
      const unknownModel: LLMModel = { provider: 'cloud', providerId: 'unknown' as any, modelId: 'test' };

      await expect(generateLLM(unknownModel, 'Test', { apiKey: 'test-key' })).rejects.toThrow('Unknown cloud provider');
    });
  });
});
