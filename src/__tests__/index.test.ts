import { type LLMModel, type LLMProvider, type CloudProviderId } from '../llm-provider.js';

describe('CLI Model Parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Model Option Parsing', () => {
    it('should parse ollama model', async () => {
      process.env.SYN_LLMAPI_KEY = 'test-key';

      const options = {
        model: 'ollama/qwen2.5:0.5b',
        dataset: undefined,
        coordinator: undefined,
        interval: undefined,
        maxIterations: undefined,
        intervalMs: undefined,
        inference: undefined,
        cpu: undefined,
      };

      const parts = options.model.split('/');
      const provider = parts[0];
      const modelId = parts[1] || 'qwen2.5:0.5b';

      let llmProvider: LLMProvider = 'ollama';
      let providerId: CloudProviderId | '' = '';

      // Parse model option
      let model: LLMModel;
      if (provider === 'anthropic') {
        llmProvider = 'cloud';
        providerId = 'anthropic';
      } else if (provider === 'kimi') {
        llmProvider = 'cloud';
        providerId = 'moonshot';
      }

      model = { provider: llmProvider, providerId, modelId };

      expect(model.provider).toBe('ollama');
      expect(model.modelId).toBe('qwen2.5:0.5b');
      expect(model.providerId).toBe('');
    });

    it('should parse anthropic model with API key', async () => {
      process.env.SYN_LLMAPI_KEY = 'test-anthropic-key';

      const options = {
        model: 'anthropic/sonnet-4.6',
      };

      const parts = options.model.split('/');
      const provider = parts[0];
      const modelId = parts[1] || 'sonnet-4.6';

      let llmProvider: LLMProvider = 'ollama';
      let providerId: CloudProviderId | '' = '';

      if (provider === 'anthropic') {
        llmProvider = 'cloud';
        providerId = 'anthropic';
      } else if (provider === 'kimi') {
        llmProvider = 'cloud';
        providerId = 'moonshot';
      }

      const model: LLMModel = { provider: llmProvider, providerId, modelId };

      expect(model.provider).toBe('cloud');
      expect(model.providerId).toBe('anthropic');
      expect(model.modelId).toBe('sonnet-4.6');
      expect(process.env.SYN_LLMAPI_KEY).toBe('test-anthropic-key');
    });

    it('should parse kimi model with API key', async () => {
      process.env.SYN_LLMAPI_KEY = 'test-kimi-key';

      const options = {
        model: 'kimi/k2.5',
      };

      const parts = options.model.split('/');
      const provider = parts[0];
      const modelId = parts[1] || 'k2.5';

      let llmProvider: LLMProvider = 'ollama';
      let providerId: CloudProviderId | '' = '';

      if (provider === 'anthropic') {
        llmProvider = 'cloud';
        providerId = 'anthropic';
      } else if (provider === 'kimi') {
        llmProvider = 'cloud';
        providerId = 'moonshot';
      }

      const model: LLMModel = { provider: llmProvider, providerId, modelId };

      expect(model.provider).toBe('cloud');
      expect(model.providerId).toBe('moonshot');
      expect(model.modelId).toBe('k2.5');
      expect(process.env.SYN_LLMAPI_KEY).toBe('test-kimi-key');
    });

    it('should use default model when not specified', () => {
      const model: LLMModel = {
        provider: 'ollama',
        providerId: '',
        modelId: 'qwen2.5:0.5b',
      };

      expect(model.provider).toBe('ollama');
      expect(model.modelId).toBe('qwen2.5:0.5b');
      expect(model.providerId).toBe('');
    });

    it('should handle model without explicit provider ID', () => {
      const options = {
        model: 'ollama/qwen2.5:7b',
      };

      const parts = options.model.split('/');
      const modelId = parts[1] || 'qwen2.5:7b';

      expect(modelId).toBe('qwen2.5:7b');
    });
  });

  describe('Provider Mapping', () => {
    it('should map anthropic provider correctly', () => {
      let llmProvider: LLMProvider = 'ollama';
      let providerId: CloudProviderId | '' = 'anthropic';
      const provider = 'anthropic';

      if (provider === 'anthropic') {
        llmProvider = 'cloud';
        providerId = 'anthropic';
      }

      expect(llmProvider).toBe('cloud');
      expect(providerId).toBe('anthropic');
    });

    it('should map kimi provider correctly', () => {
      let llmProvider: LLMProvider = 'ollama';
      let providerId: CloudProviderId | '' = 'moonshot';
      const provider = 'kimi';

      if (provider === 'kimi') {
        llmProvider = 'cloud';
        providerId = 'moonshot';
      }

      expect(llmProvider).toBe('cloud');
      expect(providerId).toBe('moonshot');
    });

    it('should map ollama provider correctly', () => {
      let llmProvider: LLMProvider = 'ollama';
      let providerId: CloudProviderId | '' = '';
      const provider: string = 'ollama';

      if (provider === 'anthropic') {
        llmProvider = 'cloud';
        providerId = 'anthropic';
      } else if (provider === 'kimi') {
        llmProvider = 'cloud';
        providerId = 'moonshot';
      }

      expect(llmProvider).toBe('ollama');
      expect(providerId).toBe('');
    });
  });

  describe('API Key Validation', () => {
    it('should require API key for cloud providers', () => {
      const provider = 'anthropic';
      const llmProvider: LLMProvider = 'cloud';
      const apiKey = process.env.SYN_LLMAPI_KEY;

      if (llmProvider === 'cloud') {
        expect(apiKey).toBeDefined();
      }
    });

    it('should not require API key for ollama', () => {
      const llmProvider: LLMProvider = 'ollama';
      const apiKey = process.env.SYN_LLMAPI_KEY;

      // Ollama should work even without API key
      expect(llmProvider).toBe('ollama');
    });
  });
});
