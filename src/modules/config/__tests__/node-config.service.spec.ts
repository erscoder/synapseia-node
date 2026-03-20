import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { NodeConfigHelper } from '../helpers/config.js';
import { NodeConfigService } from '../node-config.service.js';

const mockConfig = {
  coordinatorUrl: 'http://localhost:3001',
  defaultModel: 'ollama/qwen2.5:0.5b',
};

describe('NodeConfigService', () => {
  let service: NodeConfigService;
  let nodeConfigHelper: jest.Mocked<NodeConfigHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        NodeConfigService,
        {
          provide: NodeConfigHelper,
          useValue: {
            loadConfig: jest.fn(),
            saveConfig: jest.fn(),
            defaultConfig: jest.fn(),
            validateCoordinatorUrl: jest.fn(),
            validateModelFormat: jest.fn(),
            isCloudModel: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<NodeConfigService>(NodeConfigService);
    nodeConfigHelper = module.get(NodeConfigHelper);
  });

  it('load() delegates to nodeConfigHelper.loadConfig', () => {
    nodeConfigHelper.loadConfig.mockReturnValue(mockConfig as any);
    const result = service.load();
    expect(nodeConfigHelper.loadConfig).toHaveBeenCalled();
    expect(result).toBe(mockConfig);
  });

  it('save() delegates to nodeConfigHelper.saveConfig', () => {
    nodeConfigHelper.saveConfig.mockReturnValue(undefined);
    service.save(mockConfig as any);
    expect(nodeConfigHelper.saveConfig).toHaveBeenCalledWith(mockConfig);
  });

  it('default() delegates to nodeConfigHelper.defaultConfig', () => {
    nodeConfigHelper.defaultConfig.mockReturnValue(mockConfig as any);
    const result = service.default();
    expect(nodeConfigHelper.defaultConfig).toHaveBeenCalled();
    expect(result).toBe(mockConfig);
  });

  it('validateCoordinatorUrl() delegates correctly - valid url', () => {
    nodeConfigHelper.validateCoordinatorUrl.mockReturnValue(true);
    const result = service.validateCoordinatorUrl('http://localhost:3001');
    expect(nodeConfigHelper.validateCoordinatorUrl).toHaveBeenCalledWith('http://localhost:3001');
    expect(result).toBe(true);
  });

  it('validateCoordinatorUrl() delegates correctly - invalid url', () => {
    nodeConfigHelper.validateCoordinatorUrl.mockReturnValue(false);
    const result = service.validateCoordinatorUrl('ftp://bad');
    expect(result).toBe(false);
  });

  it('validateModelFormat() delegates correctly', () => {
    nodeConfigHelper.validateModelFormat.mockReturnValue(true);
    const result = service.validateModelFormat('ollama/qwen2.5:0.5b');
    expect(nodeConfigHelper.validateModelFormat).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(true);
  });

  it('isCloudModel() delegates for cloud model', () => {
    nodeConfigHelper.isCloudModel.mockReturnValue(true);
    const result = service.isCloudModel('anthropic/claude-3');
    expect(nodeConfigHelper.isCloudModel).toHaveBeenCalledWith('anthropic/claude-3');
    expect(result).toBe(true);
  });

  it('isCloudModel() delegates for local model', () => {
    nodeConfigHelper.isCloudModel.mockReturnValue(false);
    const result = service.isCloudModel('ollama/qwen2.5:0.5b');
    expect(result).toBe(false);
  });
});
