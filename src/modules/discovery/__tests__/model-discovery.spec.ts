import { jest } from '@jest/globals';
import axios from 'axios';
import { ModelDiscovery } from '../model-discovery';
import { MODEL_CATALOG } from '../../model/model-catalog';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock getLocalModels
jest.mock('../../model/model-catalog', () => {
  const original = jest.requireActual('../../model/model-catalog');
  return {
    ...original,
    getLocalModels: jest.fn(),
  };
});

import { getLocalModels } from '../../model/model-catalog';
const mockedGetLocalModels = getLocalModels as jest.MockedFunction<typeof getLocalModels>;

describe('ModelDiscovery', () => {
  let discovery: ModelDiscovery;

  beforeEach(() => {
    discovery = new ModelDiscovery();
    jest.clearAllMocks();
  });

  describe('registerModels', () => {
    it('should skip registration when no local models', async () => {
      mockedGetLocalModels.mockReturnValue([]);

      await discovery.registerModels('http://coordinator:3700', 'peer-1', { tier: 1 } as any);

      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should register models with coordinator', async () => {
      mockedGetLocalModels.mockReturnValue(['qwen2.5-0.5b', 'all-minilm-l6-v2']);
      mockedAxios.post.mockResolvedValue({ data: { success: true } });

      await discovery.registerModels('http://coordinator:3700', 'peer-1', { tier: 1 } as any);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://coordinator:3700/inference/register',
        expect.objectContaining({
          peerId: 'peer-1',
          models: expect.arrayContaining([
            expect.objectContaining({ name: 'qwen2.5-0.5b' }),
            expect.objectContaining({ name: 'all-minilm-l6-v2' }),
          ]),
        }),
        expect.any(Object),
      );
    });

    it('should not re-register if models have not changed', async () => {
      mockedGetLocalModels.mockReturnValue(['qwen2.5-0.5b']);
      mockedAxios.post.mockResolvedValue({ data: { success: true } });

      await discovery.registerModels('http://coordinator:3700', 'peer-1', {} as any);
      await discovery.registerModels('http://coordinator:3700', 'peer-1', {} as any);

      // Only called once because hash didn't change
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('should re-register when model list changes', async () => {
      mockedAxios.post.mockResolvedValue({ data: { success: true } });

      mockedGetLocalModels.mockReturnValue(['qwen2.5-0.5b']);
      await discovery.registerModels('http://coordinator:3700', 'peer-1', {} as any);

      mockedGetLocalModels.mockReturnValue(['qwen2.5-0.5b', 'phi-2']);
      await discovery.registerModels('http://coordinator:3700', 'peer-1', {} as any);

      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should handle network errors gracefully', async () => {
      mockedGetLocalModels.mockReturnValue(['qwen2.5-0.5b']);
      mockedAxios.post.mockRejectedValue(new Error('Connection refused'));

      // Should not throw
      await expect(
        discovery.registerModels('http://coordinator:3700', 'peer-1', {} as any),
      ).resolves.not.toThrow();
    });
  });

  describe('buildModelList', () => {
    it('should build model list from local model names', () => {
      const models = discovery.buildModelList(['qwen2.5-0.5b'], {} as any);

      expect(models).toHaveLength(1);
      expect(models[0].name).toBe('qwen2.5-0.5b');
      expect(models[0].capabilities).toContain('inference');
    });

    it('should detect embedding models', () => {
      const models = discovery.buildModelList(['all-minilm-l6-v2'], {} as any);

      expect(models[0].capabilities).toContain('embedding');
      expect(models[0].capabilities).not.toContain('inference');
    });

    it('should strip version tags from model names', () => {
      const models = discovery.buildModelList(['phi-2:latest'], {} as any);

      expect(models[0].name).toBe('phi-2');
      expect(models[0].quantization).toBe('latest');
    });

    it('should handle unknown models', () => {
      const models = discovery.buildModelList(['some-unknown-model'], {} as any);

      expect(models).toHaveLength(1);
      expect(models[0].name).toBe('some-unknown-model');
      expect(models[0].vram).toBe(0);
      expect(models[0].capabilities).toContain('inference');
    });

    it('should detect code models', () => {
      const models = discovery.buildModelList(['qwen2.5-coder-0.5b'], {} as any);

      expect(models[0].capabilities).toContain('inference');
      expect(models[0].capabilities).toContain('code');
    });

    it('should build list with multiple models', () => {
      const models = discovery.buildModelList(
        ['qwen2.5-0.5b', 'all-minilm-l6-v2', 'qwen2.5-coder-0.5b'],
        {} as any,
      );

      expect(models).toHaveLength(3);
    });

    it('should set default quantization for models without version', () => {
      const models = discovery.buildModelList(['phi-2'], {} as any);
      expect(models[0].quantization).toBe('default');
    });

    it('should set context length based on VRAM', () => {
      const models = discovery.buildModelList(['gemma-3-4b'], {} as any);
      // gemma-3-4b has minVram=4, so should get 8192
      expect(models[0].maxContextLength).toBe(8192);
    });
  });
});
