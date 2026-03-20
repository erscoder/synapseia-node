import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../model-catalog.js', () => ({
  listModels: jest.fn(),
  getModelsForVram: jest.fn(),
  getModel: jest.fn(),
  pullModel: jest.fn(),
  getLocalModels: jest.fn(),
  isModelAvailable: jest.fn(),
  getRecommendedModel: jest.fn(),
  getModelCatalog: jest.fn(),
  normalizeModelName: jest.fn(),
  getModelByName: jest.fn(),
  MODEL_CATALOG: [{ name: 'qwen2.5:0.5b', vramRequired: 1 }],
  CLOUD_MODELS: [{ name: 'claude-3', provider: 'anthropic' }],
  FULL_CATALOG: [{ name: 'qwen2.5:0.5b' }, { name: 'claude-3' }],
}));

import * as catalogHelper from '../../../model-catalog.js';
import { ModelCatalogService } from '../model-catalog.service.js';

const mockModel = { name: 'qwen2.5:0.5b', vramRequired: 1, category: 'general' };

describe('ModelCatalogService', () => {
  let service: ModelCatalogService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ModelCatalogService();
  });

  it('list() delegates to listModels without category', () => {
    (catalogHelper.listModels as jest.Mock<any>).mockReturnValue([mockModel]);
    const result = service.list();
    expect(catalogHelper.listModels).toHaveBeenCalledWith(undefined);
    expect(result).toEqual([mockModel]);
  });

  it('list() passes category', () => {
    (catalogHelper.listModels as jest.Mock<any>).mockReturnValue([mockModel]);
    service.list('general' as any);
    expect(catalogHelper.listModels).toHaveBeenCalledWith('general');
  });

  it('getForVram() delegates to getModelsForVram', () => {
    (catalogHelper.getModelsForVram as jest.Mock<any>).mockReturnValue([mockModel]);
    const result = service.getForVram(4);
    expect(catalogHelper.getModelsForVram).toHaveBeenCalledWith(4);
    expect(result).toEqual([mockModel]);
  });

  it('get() delegates to getModel', () => {
    (catalogHelper.getModel as jest.Mock<any>).mockReturnValue(mockModel);
    const result = service.get('qwen2.5:0.5b');
    expect(catalogHelper.getModel).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(mockModel);
  });

  it('get() returns undefined for unknown model', () => {
    (catalogHelper.getModel as jest.Mock<any>).mockReturnValue(undefined);
    const result = service.get('unknown');
    expect(result).toBeUndefined();
  });

  it('pull() delegates to pullModel', async () => {
    (catalogHelper.pullModel as jest.Mock<any>).mockResolvedValue(true);
    const result = await service.pull('qwen2.5:0.5b');
    expect(catalogHelper.pullModel).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(true);
  });

  it('getLocal() delegates to getLocalModels', () => {
    (catalogHelper.getLocalModels as jest.Mock<any>).mockReturnValue(['qwen2.5:0.5b']);
    const result = service.getLocal();
    expect(catalogHelper.getLocalModels).toHaveBeenCalled();
    expect(result).toEqual(['qwen2.5:0.5b']);
  });

  it('isAvailable() delegates to isModelAvailable', () => {
    (catalogHelper.isModelAvailable as jest.Mock<any>).mockReturnValue(true);
    const result = service.isAvailable('qwen2.5:0.5b');
    expect(catalogHelper.isModelAvailable).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(true);
  });

  it('getRecommended() delegates to getRecommendedModel', () => {
    (catalogHelper.getRecommendedModel as jest.Mock<any>).mockReturnValue(mockModel);
    const result = service.getRecommended(1, 'general' as any);
    expect(catalogHelper.getRecommendedModel).toHaveBeenCalledWith(1, 'general');
    expect(result).toBe(mockModel);
  });

  it('getRecommended() works without category', () => {
    (catalogHelper.getRecommendedModel as jest.Mock<any>).mockReturnValue(mockModel);
    service.getRecommended(0);
    expect(catalogHelper.getRecommendedModel).toHaveBeenCalledWith(0, undefined);
  });

  it('getCatalog() delegates to getModelCatalog', () => {
    (catalogHelper.getModelCatalog as jest.Mock<any>).mockReturnValue([mockModel]);
    const result = service.getCatalog();
    expect(catalogHelper.getModelCatalog).toHaveBeenCalled();
    expect(result).toEqual([mockModel]);
  });

  it('normalizeName() delegates to normalizeModelName', () => {
    (catalogHelper.normalizeModelName as jest.Mock<any>).mockReturnValue('qwen2.5:0.5b');
    const result = service.normalizeName('Qwen2.5:0.5B');
    expect(catalogHelper.normalizeModelName).toHaveBeenCalledWith('Qwen2.5:0.5B');
    expect(result).toBe('qwen2.5:0.5b');
  });

  it('getByName() delegates to getModelByName', () => {
    (catalogHelper.getModelByName as jest.Mock<any>).mockReturnValue(mockModel);
    const result = service.getByName('qwen2.5:0.5b');
    expect(catalogHelper.getModelByName).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(mockModel);
  });

  it('getByName() returns null for unknown', () => {
    (catalogHelper.getModelByName as jest.Mock<any>).mockReturnValue(null);
    const result = service.getByName('nope');
    expect(result).toBeNull();
  });

  it('catalog getter returns MODEL_CATALOG', () => {
    expect(service.catalog).toEqual(catalogHelper.MODEL_CATALOG);
  });

  it('cloudModels getter returns CLOUD_MODELS', () => {
    expect(service.cloudModels).toEqual(catalogHelper.CLOUD_MODELS);
  });

  it('fullCatalog getter returns FULL_CATALOG', () => {
    expect(service.fullCatalog).toEqual(catalogHelper.FULL_CATALOG);
  });
});
