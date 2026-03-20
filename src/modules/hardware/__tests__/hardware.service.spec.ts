import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { HardwareHelper } from '../../../hardware.js';
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
  let hardwareHelper: jest.Mocked<HardwareHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        HardwareService,
        {
          provide: HardwareHelper,
          useValue: {
            detectHardware: jest.fn(),
            getSystemInfo: jest.fn(),
            getCompatibleModels: jest.fn(),
            getRecommendedTier: jest.fn(),
            getTierName: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<HardwareService>(HardwareService);
    hardwareHelper = module.get(HardwareHelper);
    jest.clearAllMocks();
  });

  it('detect() delegates to hardwareHelper.detectHardware with defaults', () => {
    (hardwareHelper.detectHardware as jest.Mock<any>).mockReturnValue(mockHardware);
    const result = service.detect();
    expect(hardwareHelper.detectHardware).toHaveBeenCalledWith(false, undefined);
    expect(result).toBe(mockHardware);
  });

  it('detect() passes cpuOnly and archOverride', () => {
    (hardwareHelper.detectHardware as jest.Mock<any>).mockReturnValue(mockHardware);
    service.detect(true, 'x64');
    expect(hardwareHelper.detectHardware).toHaveBeenCalledWith(true, 'x64');
  });

  it('getSystemInfo() delegates to hardwareHelper.getSystemInfo', () => {
    (hardwareHelper.getSystemInfo as jest.Mock<any>).mockReturnValue(mockSystemInfo);
    const result = service.getSystemInfo('arm64');
    expect(hardwareHelper.getSystemInfo).toHaveBeenCalledWith('arm64');
    expect(result).toBe(mockSystemInfo);
  });

  it('getCompatibleModels() delegates to hardwareHelper.getCompatibleModels', () => {
    const models = [{ name: 'qwen2.5:0.5b', vramRequired: 1 }];
    (hardwareHelper.getCompatibleModels as jest.Mock<any>).mockReturnValue(models);
    const result = service.getCompatibleModels(4, models as any);
    expect(hardwareHelper.getCompatibleModels).toHaveBeenCalledWith(4, models);
    expect(result).toBe(models);
  });

  it('getCompatibleModels() uses empty array as default', () => {
    (hardwareHelper.getCompatibleModels as jest.Mock<any>).mockReturnValue([]);
    service.getCompatibleModels(4);
    expect(hardwareHelper.getCompatibleModels).toHaveBeenCalledWith(4, []);
  });

  it('getRecommendedTier() delegates to hardwareHelper.getRecommendedTier', () => {
    (hardwareHelper.getRecommendedTier as jest.Mock<any>).mockReturnValue(2);
    const result = service.getRecommendedTier(8);
    expect(hardwareHelper.getRecommendedTier).toHaveBeenCalledWith(8);
    expect(result).toBe(2);
  });

  it('getTierName() delegates to hardwareHelper.getTierName', () => {
    (hardwareHelper.getTierName as jest.Mock<any>).mockReturnValue('standard');
    const result = service.getTierName(1 as any);
    expect(hardwareHelper.getTierName).toHaveBeenCalledWith(1);
    expect(result).toBe('standard');
  });
});
