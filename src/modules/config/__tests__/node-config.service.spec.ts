import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../config.js', () => ({
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  defaultConfig: jest.fn(),
  validateCoordinatorUrl: jest.fn(),
  validateModelFormat: jest.fn(),
  isCloudModel: jest.fn(),
}));

import * as configHelper from '../../../config.js';
import { NodeConfigService } from '../node-config.service.js';

const mockConfig = {
  coordinatorUrl: 'http://localhost:3001',
  defaultModel: 'ollama/qwen2.5:0.5b',
};

describe('NodeConfigService', () => {
  let service: NodeConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NodeConfigService();
  });

  it('load() delegates to loadConfig', () => {
    (configHelper.loadConfig as jest.Mock<any>).mockReturnValue(mockConfig);
    const result = service.load();
    expect(configHelper.loadConfig).toHaveBeenCalled();
    expect(result).toBe(mockConfig);
  });

  it('save() delegates to saveConfig', () => {
    (configHelper.saveConfig as jest.Mock<any>).mockReturnValue(undefined);
    service.save(mockConfig as any);
    expect(configHelper.saveConfig).toHaveBeenCalledWith(mockConfig);
  });

  it('default() delegates to defaultConfig', () => {
    (configHelper.defaultConfig as jest.Mock<any>).mockReturnValue(mockConfig);
    const result = service.default();
    expect(configHelper.defaultConfig).toHaveBeenCalled();
    expect(result).toBe(mockConfig);
  });

  it('validateCoordinatorUrl() delegates correctly - valid url', () => {
    (configHelper.validateCoordinatorUrl as jest.Mock<any>).mockReturnValue(true);
    const result = service.validateCoordinatorUrl('http://localhost:3001');
    expect(configHelper.validateCoordinatorUrl).toHaveBeenCalledWith('http://localhost:3001');
    expect(result).toBe(true);
  });

  it('validateCoordinatorUrl() delegates correctly - invalid url', () => {
    (configHelper.validateCoordinatorUrl as jest.Mock<any>).mockReturnValue(false);
    const result = service.validateCoordinatorUrl('ftp://bad');
    expect(result).toBe(false);
  });

  it('validateModelFormat() delegates correctly', () => {
    (configHelper.validateModelFormat as jest.Mock<any>).mockReturnValue(true);
    const result = service.validateModelFormat('ollama/qwen2.5:0.5b');
    expect(configHelper.validateModelFormat).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(true);
  });

  it('isCloudModel() delegates for cloud model', () => {
    (configHelper.isCloudModel as jest.Mock<any>).mockReturnValue(true);
    const result = service.isCloudModel('anthropic/claude-3');
    expect(configHelper.isCloudModel).toHaveBeenCalledWith('anthropic/claude-3');
    expect(result).toBe(true);
  });

  it('isCloudModel() delegates for local model', () => {
    (configHelper.isCloudModel as jest.Mock<any>).mockReturnValue(false);
    const result = service.isCloudModel('ollama/qwen2.5:0.5b');
    expect(result).toBe(false);
  });
});
