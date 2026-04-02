import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ModelCatalogService } from '../model-catalog.service';
import { ModelCatalogHelper } from '../../model-catalog';

const mockModel = { name: 'qwen2.5:0.5b', vramRequired: 1, category: 'general' };

const MOCK_MODEL_CATALOG = [{ name: 'qwen2.5:0.5b', vramRequired: 1 }];
const MOCK_CLOUD_MODELS = [{ name: 'claude-3', provider: 'anthropic' }];
const MOCK_FULL_CATALOG = [{ name: 'qwen2.5:0.5b' }, { name: 'claude-3' }];

describe('ModelCatalogService', () => {
  let service: ModelCatalogService;
  let modelCatalogHelper: jest.Mocked<ModelCatalogHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ModelCatalogService,
        {
          provide: ModelCatalogHelper,
          useValue: {
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
          },
        },
      ],
    }).compile();

    service = module.get<ModelCatalogService>(ModelCatalogService);
    modelCatalogHelper = module.get(ModelCatalogHelper);
  });

  it('list() delegates to listModels without category', () => {
    modelCatalogHelper.listModels.mockReturnValue([mockModel] as any);
    const result = service.list();
    expect(modelCatalogHelper.listModels).toHaveBeenCalledWith(undefined);
    expect(result).toEqual([mockModel]);
  });

  it('list() passes category', () => {
    modelCatalogHelper.listModels.mockReturnValue([mockModel] as any);
    service.list('general' as any);
    expect(modelCatalogHelper.listModels).toHaveBeenCalledWith('general');
  });

  it('getForVram() delegates to getModelsForVram', () => {
    modelCatalogHelper.getModelsForVram.mockReturnValue([mockModel] as any);
    const result = service.getForVram(4);
    expect(modelCatalogHelper.getModelsForVram).toHaveBeenCalledWith(4);
    expect(result).toEqual([mockModel]);
  });

  it('get() delegates to getModel', () => {
    modelCatalogHelper.getModel.mockReturnValue(mockModel as any);
    const result = service.get('qwen2.5:0.5b');
    expect(modelCatalogHelper.getModel).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(mockModel);
  });

  it('get() returns undefined for unknown model', () => {
    modelCatalogHelper.getModel.mockReturnValue(undefined);
    const result = service.get('unknown');
    expect(result).toBeUndefined();
  });

  it('pull() delegates to pullModel', async () => {
    modelCatalogHelper.pullModel.mockResolvedValue(true);
    const result = await service.pull('qwen2.5:0.5b');
    expect(modelCatalogHelper.pullModel).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(true);
  });

  it('getLocal() delegates to getLocalModels', () => {
    modelCatalogHelper.getLocalModels.mockReturnValue(['qwen2.5:0.5b']);
    const result = service.getLocal();
    expect(modelCatalogHelper.getLocalModels).toHaveBeenCalled();
    expect(result).toEqual(['qwen2.5:0.5b']);
  });

  it('isAvailable() delegates to isModelAvailable', () => {
    modelCatalogHelper.isModelAvailable.mockReturnValue(true);
    const result = service.isAvailable('qwen2.5:0.5b');
    expect(modelCatalogHelper.isModelAvailable).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(true);
  });

  it('getRecommended() delegates to getRecommendedModel', () => {
    modelCatalogHelper.getRecommendedModel.mockReturnValue(mockModel as any);
    const result = service.getRecommended(1, 'general' as any);
    expect(modelCatalogHelper.getRecommendedModel).toHaveBeenCalledWith(1, 'general');
    expect(result).toBe(mockModel);
  });

  it('getRecommended() works without category', () => {
    modelCatalogHelper.getRecommendedModel.mockReturnValue(mockModel as any);
    service.getRecommended(0);
    expect(modelCatalogHelper.getRecommendedModel).toHaveBeenCalledWith(0, undefined);
  });

  it('getCatalog() delegates to getModelCatalog', () => {
    modelCatalogHelper.getModelCatalog.mockReturnValue([mockModel] as any);
    const result = service.getCatalog();
    expect(modelCatalogHelper.getModelCatalog).toHaveBeenCalled();
    expect(result).toEqual([mockModel]);
  });

  it('normalizeName() delegates to normalizeModelName', () => {
    modelCatalogHelper.normalizeModelName.mockReturnValue('qwen2.5:0.5b');
    const result = service.normalizeName('Qwen2.5:0.5B');
    expect(modelCatalogHelper.normalizeModelName).toHaveBeenCalledWith('Qwen2.5:0.5B');
    expect(result).toBe('qwen2.5:0.5b');
  });

  it('getByName() delegates to getModelByName', () => {
    modelCatalogHelper.getModelByName.mockReturnValue(mockModel as any);
    const result = service.getByName('qwen2.5:0.5b');
    expect(modelCatalogHelper.getModelByName).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(result).toBe(mockModel);
  });

  it('getByName() returns null for unknown', () => {
    modelCatalogHelper.getModelByName.mockReturnValue(null);
    const result = service.getByName('nope');
    expect(result).toBeNull();
  });

  it('catalog getter returns MODEL_CATALOG constant', () => {
    expect(Array.isArray(service.catalog)).toBe(true);
  });

  it('cloudModels getter returns CLOUD_MODELS constant', () => {
    expect(Array.isArray(service.cloudModels)).toBe(true);
  });

  it('fullCatalog getter returns FULL_CATALOG constant', () => {
    expect(Array.isArray(service.fullCatalog)).toBe(true);
  });
});
