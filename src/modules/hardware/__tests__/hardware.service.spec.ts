import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../hardware.js', () => ({
  detectHardware: jest.fn(),
  getSystemInfo: jest.fn(),
  getCompatibleModels: jest.fn(),
  getRecommendedTier: jest.fn(),
  getTierName: jest.fn(),
}));

import * as hwHelper from '../../../hardware.js';
import { HardwareService } from '../hardware.service.js';

const mockHardware = {
  arch: 'arm64' as const,
  cpuCores: 8,
  ramGb: 16,
  vramGb: 0,
  isOllamaRunning: false,
  tier: 1,
  tierName: 'standard',
};

const mockSystemInfo = {
  platform: 'darwin',
  arch: 'arm64',
  totalMemoryGb: 16,
  cpuModel: 'Apple M1',
  gpuInfo: 'none',
};

describe('HardwareService', () => {
  let service: HardwareService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HardwareService();
  });

  it('detect() delegates to detectHardware with defaults', () => {
    (hwHelper.detectHardware as jest.Mock<any>).mockReturnValue(mockHardware);
    const result = service.detect();
    expect(hwHelper.detectHardware).toHaveBeenCalledWith(false, undefined);
    expect(result).toBe(mockHardware);
  });

  it('detect() passes cpuOnly and archOverride', () => {
    (hwHelper.detectHardware as jest.Mock<any>).mockReturnValue(mockHardware);
    service.detect(true, 'x64');
    expect(hwHelper.detectHardware).toHaveBeenCalledWith(true, 'x64');
  });

  it('getSystemInfo() delegates to getSystemInfo', () => {
    (hwHelper.getSystemInfo as jest.Mock<any>).mockReturnValue(mockSystemInfo);
    const result = service.getSystemInfo('arm64');
    expect(hwHelper.getSystemInfo).toHaveBeenCalledWith('arm64');
    expect(result).toBe(mockSystemInfo);
  });

  it('getCompatibleModels() delegates to getCompatibleModels', () => {
    const models = [{ name: 'qwen2.5:0.5b', vramRequired: 1 }];
    (hwHelper.getCompatibleModels as jest.Mock<any>).mockReturnValue(models);
    const result = service.getCompatibleModels(4, models as any);
    expect(hwHelper.getCompatibleModels).toHaveBeenCalledWith(4, models);
    expect(result).toBe(models);
  });

  it('getCompatibleModels() uses empty array as default', () => {
    (hwHelper.getCompatibleModels as jest.Mock<any>).mockReturnValue([]);
    service.getCompatibleModels(4);
    expect(hwHelper.getCompatibleModels).toHaveBeenCalledWith(4, []);
  });

  it('getRecommendedTier() delegates to getRecommendedTier', () => {
    (hwHelper.getRecommendedTier as jest.Mock<any>).mockReturnValue(2);
    const result = service.getRecommendedTier(8);
    expect(hwHelper.getRecommendedTier).toHaveBeenCalledWith(8);
    expect(result).toBe(2);
  });

  it('getTierName() delegates to getTierName', () => {
    (hwHelper.getTierName as jest.Mock<any>).mockReturnValue('standard');
    const result = service.getTierName(1 as any);
    expect(hwHelper.getTierName).toHaveBeenCalledWith(1);
    expect(result).toBe('standard');
  });
});
