import { jest } from '@jest/globals';
import {
  listModels,
  getModelsForVram,
  getModel,
  pullModel,
  getLocalModels,
  isModelAvailable,
  getRecommendedModel,
  getModelCatalog,
  getModelByName,
  normalizeModelName,
  MODEL_CATALOG,
  CLOUD_MODELS,
  FULL_CATALOG,
  ModelInfo,
  ModelCategory,
} from '../modules/model/model-catalog';
import { execSync } from 'child_process';

// ESM-compatible mock: declare before jest.mock so factory can reference it
// Use var so jest.mock() factory (which is hoisted) can reference it at initialization
var mockExecSync: any = jest.fn();

// Mock execSync for testing
jest.mock('child_process', () => ({
  execSync: mockExecSync,
}));

describe('Model Catalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Catalog Constants', () => {
    it('should have 25 local models in MODEL_CATALOG', () => {
      expect(MODEL_CATALOG.length).toBe(25);
    });

    it('should have 3 cloud models in CLOUD_MODELS', () => {
      expect(CLOUD_MODELS.length).toBe(3);
    });

    it('should have 28 models in FULL_CATALOG', () => {
      expect(FULL_CATALOG.length).toBe(28);
    });

    it.skip('should have required models from specification', () => {
      const modelNames = FULL_CATALOG.map((m) => m.name);
      const requiredModels = [
        'qwen2.5-0.5b',
        'qwen2.5-coder-0.5b',
        'qwen2.5-coder-1.5b',
        'gemma-3-1b-web',
        'qwen2.5-coder-3b',
        'gemma-3-1b',
        'gemma-3-4b',
        'qwen2.5-coder-7b',
        'glm-4-9b',
        'gemma-3-12b',
        'qwen2.5-coder-14b',
        'gpt-oss-20b',
        'gemma-3-27b',
        'glm-4.7-flash',
        'qwen3-coder-30b-a3b',
        'qwen2.5-coder-32b',
        'llama-3.1-8b-instruct',
        'llama-3.2-1b-instruct',
        'mistral-7b-instruct',
        'phi-2',
        'tiny-vicuna-1b',
        'home-3b-v3',
        'qwen2-0.5b',
        'qwen2-0.5b-instruct',
        'all-minilm-l6-v2',
        'gemini-2.0-flash',
      ];

      requiredModels.forEach((model) => {
        expect(modelNames).toContain(model);
      });
    });

    it('should have correct category for each model', () => {
      const categories = ['embedding', 'general', 'code', 'multilingual'] as const;
      FULL_CATALOG.forEach((model) => {
        expect(categories).toContain(model.category);
      });
    });
  });

  describe('listModels', () => {
    it('should return all models when no category specified', () => {
      const models = listModels();
      expect(models).toHaveLength(28);
    });

    it('should filter by embedding category', () => {
      const models = listModels('embedding');
      expect(models.length).toBeGreaterThan(0);
      models.forEach((m) => expect(m.category).toBe('embedding'));
    });

    it('should filter by general category', () => {
      const models = listModels('general');
      expect(models.length).toBeGreaterThan(0);
      models.forEach((m) => expect(m.category).toBe('general'));
    });

    it('should filter by code category', () => {
      const models = listModels('code');
      expect(models.length).toBeGreaterThan(0);
      models.forEach((m) => expect(m.category).toBe('code'));
    });

    it('should filter by multilingual category', () => {
      const models = listModels('multilingual');
      // May be empty if no multilingual models in catalog
      expect(Array.isArray(models)).toBe(true);
      models.forEach((m) => expect(m.category).toBe('multilingual'));
    });
  });

  describe('getModelsForVram', () => {
    it('should return empty array for 0 VRAM (excluding cloud models)', () => {
      const models = getModelsForVram(0);
      expect(models).toHaveLength(0);
    });

    it('should return compatible models for 1GB VRAM', () => {
      const models = getModelsForVram(1);
      expect(models.length).toBeGreaterThan(0);
      models.forEach((m) => {
        expect(m.minVram).toBeLessThanOrEqual(1);
        expect(m.isCloud).toBeFalsy();
      });
    });

    it('should return compatible models for 8GB VRAM', () => {
      const models = getModelsForVram(8);
      expect(models.length).toBeGreaterThan(0);
      models.forEach((m) => {
        expect(m.minVram).toBeLessThanOrEqual(8);
        expect(m.isCloud).toBeFalsy();
      });
    });

    it('should return compatible models for 32GB VRAM', () => {
      const models = getModelsForVram(32);
      expect(models.length).toBeGreaterThan(0);
      models.forEach((m) => {
        expect(m.minVram).toBeLessThanOrEqual(32);
        expect(m.isCloud).toBeFalsy();
      });
    });

    it('should exclude cloud models', () => {
      const models = getModelsForVram(128);
      models.forEach((m) => {
        expect(m.isCloud).toBeFalsy();
      });
    });

    it('should return all local models for high VRAM', () => {
      const models = getModelsForVram(128);
      expect(models).toHaveLength(25); // All local models
    });
  });

  describe('getModel', () => {
    it('should find qwen2.5-0.5b', () => {
      const model = getModel('qwen2.5-0.5b');
      expect(model).toBeDefined();
      expect(model?.name).toBe('qwen2.5-0.5b');
      expect(model?.minVram).toBe(1);
      expect(model?.category).toBe('general');
    });

    it('should find llama-3.1-8b-instruct', () => {
      const model = getModel('llama-3.1-8b-instruct');
      expect(model).toBeDefined();
      expect(model?.name).toBe('llama-3.1-8b-instruct');
    });

    it('should find gemini-2.0-flash (cloud model)', () => {
      const model = getModel('gemini-2.0-flash');
      expect(model).toBeDefined();
      expect(model?.name).toBe('gemini-2.0-flash');
      expect(model?.isCloud).toBe(true);
    });

    it('should return undefined for non-existent model', () => {
      const model = getModel('non-existent-model');
      expect(model).toBeUndefined();
    });
  });

  describe('getLocalModels', () => {
    it.skip('should return empty array when Ollama not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Ollama not running');
      });

      const models = getLocalModels();
      expect(models).toHaveLength(0);
    });

    it.skip('should parse Ollama response correctly', () => {
      const mockResponse = JSON.stringify({
        models: [
          { name: 'qwen2.5-0.5b', modified_at: '2024-01-01T00:00:00Z', size: 1234567 },
          { name: 'llama-3.1-8b-instruct', modified_at: '2024-01-01T00:00:00Z', size: 7654321 },
        ],
      });

      mockExecSync.mockReturnValue(mockResponse);

      const models = getLocalModels();
      expect(models).toHaveLength(2);
      expect(models).toContain('qwen2.5-0.5b');
      expect(models).toContain('llama-3.1-8b-instruct');
    });

    it.skip('should handle empty Ollama response', () => {
      mockExecSync.mockReturnValue(JSON.stringify({ models: [] }));

      const models = getLocalModels();
      expect(models).toHaveLength(0);
    });
  });

  describe('isModelAvailable', () => {
    it.skip('should return true for available model', () => {
      const mockResponse = JSON.stringify({
        models: [
          { name: 'qwen2.5-0.5b', modified_at: '2024-01-01T00:00:00Z', size: 1234567 },
        ],
      });

      mockExecSync.mockReturnValue(mockResponse);

      expect(isModelAvailable('qwen2.5-0.5b')).toBe(true);
    });

    it('should return false for unavailable model', () => {
      const mockResponse = JSON.stringify({
        models: [{ name: 'qwen2.5-0.5b', modified_at: '2024-01-01T00:00:00Z', size: 1234567 }],
      });

      mockExecSync.mockReturnValue(mockResponse);

      expect(isModelAvailable('llama-3.1-8b-instruct')).toBe(false);
    });

    it('should return false when Ollama not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Ollama not running');
      });

      expect(isModelAvailable('qwen2.5-0.5b')).toBe(false);
    });
  });

  describe('getRecommendedModel', () => {
    it('should return recommended model for tier 1', () => {
      const model = getRecommendedModel(1);
      expect(model).toBeDefined();
      expect(model?.recommendedTier).toBeLessThanOrEqual(1);
    });

    it('should return recommended model for tier 3', () => {
      const model = getRecommendedModel(3);
      expect(model).toBeDefined();
      expect(model?.minVram).toBeLessThanOrEqual(48);
    });

    it('should return recommended model for tier 5', () => {
      const model = getRecommendedModel(5);
      expect(model).toBeDefined();
      expect(model?.minVram).toBeLessThanOrEqual(80);
    });

    it('should filter by category if provided', () => {
      const model = getRecommendedModel(2, 'code');
      expect(model).toBeDefined();
      expect(model?.category).toBe('code');
    });

    it('should return undefined when no models available', () => {
      const model = getRecommendedModel(0);
      // Tier 0 has very limited VRAM, no models have 0 minVram (except embedding)
      expect(model).toBeUndefined();
    });
  });

  describe('Model structure validation', () => {
    it('should have valid structure for all models', () => {
      FULL_CATALOG.forEach((model) => {
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('minVram');
        expect(model).toHaveProperty('recommendedTier');
        expect(model).toHaveProperty('category');

        expect(typeof model.name).toBe('string');
        expect(typeof model.minVram).toBe('number');
        expect(typeof model.recommendedTier).toBe('number');
        expect(typeof model.category).toBe('string');

        expect(model.minVram).toBeGreaterThanOrEqual(0);
        expect(model.recommendedTier).toBeGreaterThanOrEqual(0);
        expect(model.recommendedTier).toBeLessThanOrEqual(5);
      });
    });

    it('should have unique model names', () => {
      const names = FULL_CATALOG.map((m) => m.name);
      const uniqueNames = new Set(names);
      expect(names.length).toBe(uniqueNames.size);
    });
  });

  describe('Edge cases', () => {
    it('should handle very high VRAM', () => {
      const models = getModelsForVram(1000);
      expect(models.length).toBe(25); // All local models
    });

    it('should handle negative VRAM', () => {
      const models = getModelsForVram(-1);
      expect(models).toHaveLength(0);
    });

    it('should handle floating point VRAM', () => {
      const models = getModelsForVram(4.5);
      expect(models.length).toBeGreaterThan(0);
      models.forEach((m) => expect(m.minVram).toBeLessThanOrEqual(4.5));
    });
  });

  describe('pullModel', () => {
    it.skip('should throw error when Ollama not running', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Ollama not running');
      });

      await expect(pullModel('qwen2.5-0.5b')).rejects.toThrow(
        'Ollama is not running. Start it with: ollama serve'
      );
    });

    it.skip('should check Ollama availability before pulling', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: check Ollama availability
          return '';
        } else {
          // Second call: pull model
          throw new Error('Pull failed');
        }
      });

      await expect(pullModel('qwen2.5-0.5b')).rejects.toThrow('Pull failed');
      expect(mockExecSync).toHaveBeenCalledWith('curl -s http://localhost:11434/api/tags', {
        stdio: 'pipe',
        timeout: 1000,
      });
    });
  });

  describe('getModelCatalog', () => {
    it('should return local models catalog (no cloud models)', () => {
      const catalog = getModelCatalog();
      expect(catalog).toHaveLength(25);
      catalog.forEach((model) => {
        expect(model.isCloud).toBeFalsy();
      });
    });

    it('should not include cloud models', () => {
      const catalog = getModelCatalog();
      expect(catalog.find((m) => m.name === 'gemini-2.0-flash')).toBeUndefined();
    });
  });

  describe('normalizeModelName', () => {
    it('should remove ollama prefix', () => {
      expect(normalizeModelName('ollama/qwen2.5-0.5b')).toBe('qwen2.5-0.5b');
    });

    it('should replace colons with dashes', () => {
      expect(normalizeModelName('qwen2.5:0.5b')).toBe('qwen2.5-0.5b');
    });

    it('should lowercase the name', () => {
      expect(normalizeModelName('QWEN2.5-0.5B')).toBe('qwen2.5-0.5b');
    });

    it('should handle ollama/ prefix with colons', () => {
      expect(normalizeModelName('ollama/qwen2.5:0.5b')).toBe('qwen2.5-0.5b');
    });

    it('should handle already normalized names', () => {
      expect(normalizeModelName('qwen2.5-0.5b')).toBe('qwen2.5-0.5b');
    });
  });

  describe('getModelByName', () => {
    it('should find model by exact name', () => {
      const model = getModelByName('qwen2.5-0.5b');
      expect(model).not.toBeNull();
      expect(model?.name).toBe('qwen2.5-0.5b');
    });

    it('should find model with ollama prefix', () => {
      const model = getModelByName('ollama/qwen2.5-0.5b');
      expect(model).not.toBeNull();
      expect(model?.name).toBe('qwen2.5-0.5b');
    });

    it('should find model with colon format', () => {
      const model = getModelByName('qwen2.5:0.5b');
      expect(model).not.toBeNull();
      expect(model?.name).toBe('qwen2.5-0.5b');
    });

    it('should find model with ollama/ prefix and colon', () => {
      const model = getModelByName('ollama/qwen2.5:0.5b');
      expect(model).not.toBeNull();
      expect(model?.name).toBe('qwen2.5-0.5b');
    });

    it('should return null for non-existent model', () => {
      const model = getModelByName('non-existent-model');
      expect(model).toBeNull();
    });

    it('should be case insensitive', () => {
      const model = getModelByName('QWEN2.5-0.5B');
      expect(model).not.toBeNull();
      expect(model?.name).toBe('qwen2.5-0.5b');
    });

    it('should not find cloud models', () => {
      const model = getModelByName('ollama/gemini-2.0-flash');
      expect(model).toBeNull();
    });

    it('should handle mixed format models', () => {
      const model = getModelByName('ollama/llama-3.1-8b-instruct');
      expect(model).not.toBeNull();
      expect(model?.name).toBe('llama-3.1-8b-instruct');
    });
  });
});
