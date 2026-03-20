import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import axios from 'axios';
import { checkOllama, pullModel, generate, ensureModel } from '../modules/llm/helpers/ollama';

// Mock axios
jest.mock('axios');

// Mock ollama class
jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    pull: jest.fn(),
    chat: jest.fn(),
  })),
}));

// Mock hardware module
jest.mock('../modules/hardware/helpers/hardware.js', () => ({
  detectHardware: jest.fn(),
}));

import { Ollama } from 'ollama';
import { detectHardware } from '../modules/hardware/helpers/hardware.js';

const mockOllama = Ollama as jest.MockedClass<typeof Ollama>;

describe('Ollama Module', () => {
  const mockOllamaUrl = 'http://localhost:11434';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkOllama', () => {
    it('should return available status with models when Ollama is running', async () => {
      const mockModels = [
        { name: 'qwen2.5:0.5b' },
        { name: 'qwen2.5:3b' },
        { name: 'llama2:7b' },
      ];

      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: mockModels },
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0,
        hasOllama: true,
      });

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(true);
      expect(status.url).toBe(mockOllamaUrl);
      expect(status.models).toEqual(['qwen2.5:0.5b', 'qwen2.5:3b', 'llama2:7b']);
      expect(status.recommendedModel).toBe('qwen2.5:0.5b'); // CPU-only
      expect(status.error).toBeUndefined();
    });

    it('should recommend GPU model when GPU is detected', async () => {
      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: [{ name: 'qwen2.5:0.5b' }] },
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 24,
        tier: 3,
        hasOllama: true,
      });

      const status = await checkOllama(mockOllamaUrl);

      expect(status.recommendedModel).toBe('qwen2.5:3b'); // GPU detected
    });

    it('should return unavailable status when Ollama is not running', async () => {
      const axiosError = { message: 'ECONNREFUSED', isAxiosError: true } as any;
      (axios.get as jest.Mock).mockRejectedValue(axiosError);

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(false);
      expect(status.url).toBe(mockOllamaUrl);
      expect(status.models).toEqual([]);
      expect(status.recommendedModel).toBe('qwen2.5:0.5b');
      expect(status.error).toBe('Cannot connect to Ollama at http://localhost:11434: ECONNREFUSED');
    });

    it('should timeout after 5 seconds', async () => {
      (axios.get as jest.Mock).mockRejectedValue(new Error('timeout of 5000ms exceeded'));

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(false);
      expect(status.error).toContain('timeout');
    });

    it('should handle non-Axios errors', async () => {
      const nonAxiosError = new TypeError('Invalid URL');
      (axios.get as jest.Mock).mockRejectedValue(nonAxiosError);

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Invalid URL');
    });

    it('should handle unknown errors', async () => {
      (axios.get as jest.Mock).mockRejectedValue('some string error' as any);

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });

    it('should handle object errors without message property', async () => {
      (axios.get as jest.Mock).mockRejectedValue({ code: 'ETIMEDOUT' } as any);

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });

    it('should handle error with null error object', async () => {
      (axios.get as jest.Mock).mockRejectedValue(null as any);

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });

    it('should handle error with undefined error object', async () => {
      (axios.get as jest.Mock).mockRejectedValue(undefined as any);

      const status = await checkOllama(mockOllamaUrl);

      expect(status.available).toBe(false);
      expect(status.error).toBe('Unknown error');
    });
  });

  describe('pullModel', () => {
    it('should pull a model and log progress', async () => {
      const asyncGenerator = async function* () {
        yield { digest: 'sha256:abc123', total: 1000, completed: 500 };
        yield { digest: 'sha256:abc123', total: 1000, completed: 1000 };
        yield { status: 'success' };
      };

      const ollamaInstance = {
        pull: jest.fn().mockResolvedValue(asyncGenerator()),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await pullModel('qwen2.5:0.5b', mockOllamaUrl);

      expect(mockOllama).toHaveBeenCalledWith({ host: mockOllamaUrl });
      expect(ollamaInstance.pull).toHaveBeenCalledWith({
        model: 'qwen2.5:0.5b',
        stream: true,
      });

      expect(consoleSpy).toHaveBeenCalledWith('📥 Pulling model qwen2.5:0.5b from Ollama...');
      expect(consoleSpy).toHaveBeenCalledWith('📦 qwen2.5:0.5b: 50% complete');
      expect(consoleSpy).toHaveBeenCalledWith('✅ Model qwen2.5:0.5b downloaded successfully');

      consoleSpy.mockRestore();
    });

    it('should throw error when pull fails', async () => {
      const ollamaInstance = {
        pull: jest.fn().mockRejectedValue(new Error('Network error')),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      await expect(pullModel('qwen2.5:0.5b', mockOllamaUrl)).rejects.toThrow(
        'Failed to pull model qwen2.5:0.5b: Network error'
      );
    });

    it('should handle pull without total/completed info', async () => {
      const asyncGenerator = async function* () {
        yield { status: 'success' };
      };

      const ollamaInstance = {
        pull: jest.fn().mockResolvedValue(asyncGenerator()),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      await pullModel('qwen2.5:0.5b', mockOllamaUrl);

      expect(ollamaInstance.pull).toHaveBeenCalled();
    });
  });

  describe('generate', () => {
    it('should generate text with specified model', async () => {
      const mockResponse = {
        message: { content: 'The answer is 42' },
      };

      const ollamaInstance = {
        chat: jest.fn().mockResolvedValue(mockResponse),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await generate('What is the meaning of life?', 'llama2:7b', mockOllamaUrl);

      expect(result).toBe('The answer is 42');
      expect(ollamaInstance.chat).toHaveBeenCalledWith({
        model: 'llama2:7b',
        messages: [
          {
            role: 'user',
            content: 'What is the meaning of life?',
          },
        ],
        stream: false,
      });

      jest.restoreAllMocks();
    });

    it('should use recommended model when none specified and Ollama is available', async () => {
      const mockResponse = {
        message: { content: 'Generated response' },
      };

      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: [{ name: 'qwen2.5:0.5b' }] },
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0,
        hasOllama: true,
      });

      const ollamaInstance = {
        chat: jest.fn().mockResolvedValue(mockResponse),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await generate('Test prompt', undefined, mockOllamaUrl);

      expect(result).toBe('Generated response');
      expect(ollamaInstance.chat).toHaveBeenCalledWith({
        model: 'qwen2.5:0.5b', // Recommended model
        messages: [{ role: 'user', content: 'Test prompt' }],
        stream: false,
      });

      jest.restoreAllMocks();
    });

    it('should throw error when Ollama is not available', async () => {
      (axios.get as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      await expect(generate('Test', undefined, mockOllamaUrl)).rejects.toThrow('Ollama is not available');
    });

    it('should handle generation errors', async () => {
      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: [{ name: 'qwen2.5:0.5b' }] },
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0,
        hasOllama: true,
      });

      const ollamaInstance = {
        chat: jest.fn().mockRejectedValue(new Error('Model not found')),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      await expect(generate('Test', 'qwen2.5:0.5b', mockOllamaUrl)).rejects.toThrow('Generation failed: Model not found');
    });

    it('should trim whitespace from generated content', async () => {
      const mockResponse = {
        message: { content: '  Response with spaces  \n  ' },
      };

      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: [{ name: 'qwen2.5:0.5b' }] },
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0,
        hasOllama: true,
      });

      const ollamaInstance = {
        chat: jest.fn().mockResolvedValue(mockResponse),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await generate('Test', 'qwen2.5:0.5b', mockOllamaUrl);

      expect(result).toBe('Response with spaces');

      jest.restoreAllMocks();
    });
  });

  describe('ensureModel', () => {
    it('should throw error when Ollama is not running', async () => {
      (axios.get as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      await expect(ensureModel('qwen2.5:0.5b', mockOllamaUrl)).rejects.toThrow(
        'Ollama is not running. Start with: ollama serve'
      );
    });

    it('should pull model when not available', async () => {
      const asyncGenerator = async function* () {
        yield { status: 'success' };
      };

      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: [{ name: 'llama2:7b' }] }, // Different model
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0,
        hasOllama: true,
      });

      const ollamaInstance = {
        pull: jest.fn().mockResolvedValue(asyncGenerator()),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      jest.spyOn(console, 'log').mockImplementation(() => {});

      await ensureModel('qwen2.5:0.5b', mockOllamaUrl);

      expect(ollamaInstance.pull).toHaveBeenCalledWith({
        model: 'qwen2.5:0.5b',
        stream: true,
      });

      jest.restoreAllMocks();
    });

    it('should not pull model when already available', async () => {
      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: [{ name: 'qwen2.5:0.5b' }] },
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0,
        hasOllama: true,
      });

      const ollamaInstance = {
        pull: jest.fn(),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      jest.spyOn(console, 'log').mockImplementation(() => {});

      await ensureModel('qwen2.5:0.5b', mockOllamaUrl);

      expect(ollamaInstance.pull).not.toHaveBeenCalled();

      jest.restoreAllMocks();
    });

    it('should match model family when checking availability (ignoring tags)', async () => {
      (axios.get as jest.Mock).mockResolvedValue({
        data: { models: [{ name: 'qwen2.5:3b' }] }, // Different tag, same family
      } as any);

      (detectHardware as jest.Mock).mockResolvedValue({
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0,
        hasOllama: true,
      });

      const ollamaInstance = {
        pull: jest.fn(),
      };

      (mockOllama as jest.Mock).mockReturnValue(ollamaInstance);

      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(ensureModel('qwen2.5:0.5b', mockOllamaUrl)).resolves.not.toThrow();

      // Should NOT pull - same family found
      expect(ollamaInstance.pull).not.toHaveBeenCalled();

      jest.restoreAllMocks();
    });
  });
});
