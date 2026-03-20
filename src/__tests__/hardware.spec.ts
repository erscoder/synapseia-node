import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  detectHardware,
  detectAppleSilicon,
  detectNvidiaGPU,
  getTierName,
  getSystemInfo,
  getCompatibleModels,
  getRecommendedTier,
  buildOsString,
  estimateAppleSiliconVram,
  parseNvidiaSmiOutput,
  type Hardware,
} from '../modules/hardware/hardware.js';
import * as os from 'os';
import * as childProcess from 'child_process';

describe('Hardware Detection', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('detectHardware', () => {
    it('should detect CPU cores', () => {
      const hardware = detectHardware(true);
      expect(hardware.cpuCores).toBeGreaterThan(0);
      expect(typeof hardware.cpuCores).toBe('number');
    });

    it('should detect RAM', () => {
      const hardware = detectHardware(true);
      expect(hardware.ramGb).toBeGreaterThan(0);
      expect(typeof hardware.ramGb).toBe('number');
    });

    it('should return tier 0 for CPU-only detection', () => {
      const hardware = detectHardware(true);
      expect(hardware.tier).toBe(0);
      expect(hardware.gpuVramGb).toBe(0);
    });

    it.skip('should detect Ollama availability', () => {
      jest.restoreAllMocks();
      const mockExecSync = jest.spyOn(childProcess, 'execSync').mockReturnValue('{"models": []}');

      const hardware = detectHardware(false);
      expect(typeof hardware.hasOllama).toBe('boolean');

      mockExecSync.mockRestore();
    });

    it('should return valid hardware structure', () => {
      const hardware = detectHardware(false);
      expect(hardware).toHaveProperty('cpuCores');
      expect(hardware).toHaveProperty('ramGb');
      expect(hardware).toHaveProperty('gpuVramGb');
      expect(hardware).toHaveProperty('tier');
      expect(hardware).toHaveProperty('hasOllama');
    });
  });

  describe('getTierName', () => {
    it('should return correct tier names', () => {
      expect(getTierName(0)).toBe('CPU-Only');
      expect(getTierName(1)).toBe('Tier 1');
      expect(getTierName(2)).toBe('Tier 2');
      expect(getTierName(3)).toBe('Tier 3');
      expect(getTierName(4)).toBe('Tier 4');
      expect(getTierName(5)).toBe('Tier 5');
    });

    it('should handle invalid values gracefully', () => {
      // Using type assertion to test invalid inputs
      expect(getTierName(6 as any)).toBe('Unknown');
      expect(getTierName(-1 as any)).toBe('Unknown');
      expect(getTierName(10 as any)).toBe('Unknown');
    });
  });

  describe('getSystemInfo', () => {
    it('should return valid system info structure', () => {
      const sysInfo = getSystemInfo();
      expect(sysInfo).toHaveProperty('os');
      expect(sysInfo).toHaveProperty('cpu');
      expect(sysInfo).toHaveProperty('memory');
      expect(sysInfo).toHaveProperty('gpu');

      expect(sysInfo.cpu).toHaveProperty('model');
      expect(sysInfo.cpu).toHaveProperty('cores');
      expect(sysInfo.memory).toHaveProperty('totalGb');
      expect(sysInfo.gpu).toHaveProperty('type');
      expect(sysInfo.gpu).toHaveProperty('vramGb');
    });
  });

  describe('getRecommendedTier', () => {
    it('should return tier 0 for 0 VRAM', () => {
      expect(getRecommendedTier(0)).toBe(0);
    });

    it('should return tier 1 for VRAM < 1GB', () => {
      expect(getRecommendedTier(0.5)).toBe(0);
    });

    it('should return tier 1 for VRAM 1-5GB', () => {
      expect(getRecommendedTier(1)).toBe(1);
      expect(getRecommendedTier(4)).toBe(1);
    });

    it('should return tier 2 for VRAM 6-9GB', () => {
      expect(getRecommendedTier(6)).toBe(2);
      expect(getRecommendedTier(8)).toBe(2);
    });

    it('should return tier 3 for VRAM 10-15GB', () => {
      expect(getRecommendedTier(10)).toBe(3);
      expect(getRecommendedTier(14)).toBe(3);
    });

    it('should return tier 4 for VRAM 16-47GB', () => {
      expect(getRecommendedTier(16)).toBe(4);
      expect(getRecommendedTier(32)).toBe(4);
    });

    it('should return tier 5 for VRAM >= 48GB', () => {
      expect(getRecommendedTier(48)).toBe(5);
      expect(getRecommendedTier(64)).toBe(5);
      expect(getRecommendedTier(128)).toBe(5);
    });

    it('should handle negative VRAM', () => {
      expect(getRecommendedTier(-1)).toBe(0);
    });

    it('should handle very large VRAM', () => {
      expect(getRecommendedTier(512)).toBe(5);
    });
  });

  describe('getCompatibleModels', () => {
    it('should return default models when no catalog provided', () => {
      const models = getCompatibleModels(24);
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('should filter models by VRAM requirement', () => {
      const allModels = [
        { name: 'model-1gb', minVram: 1, recommendedTier: 1 },
        { name: 'model-8gb', minVram: 8, recommendedTier: 2 },
        { name: 'model-16gb', minVram: 16, recommendedTier: 3 },
        { name: 'model-32gb', minVram: 32, recommendedTier: 4 },
      ];

      const compatible = getCompatibleModels(8, allModels);
      expect(compatible).toHaveLength(2);
      expect(compatible.map((m) => m.name)).toEqual(['model-1gb', 'model-8gb']);
    });

    it('should return empty array when no models compatible', () => {
      const allModels = [
        { name: 'model-32gb', minVram: 32, recommendedTier: 4 },
      ];

      const compatible = getCompatibleModels(8, allModels);
      expect(compatible).toHaveLength(0);
    });

    it('should handle exact VRAM match', () => {
      const allModels = [
        { name: 'model-8gb', minVram: 8, recommendedTier: 2 },
      ];

      const compatible = getCompatibleModels(8, allModels);
      expect(compatible).toHaveLength(1);
      expect(compatible[0].name).toBe('model-8gb');
    });

    it('should return all models when VRAM is high', () => {
      const allModels = [
        { name: 'model-1gb', minVram: 1, recommendedTier: 1 },
        { name: 'model-8gb', minVram: 8, recommendedTier: 2 },
        { name: 'model-16gb', minVram: 16, recommendedTier: 3 },
      ];

      const compatible = getCompatibleModels(128, allModels);
      expect(compatible).toHaveLength(3);
    });

    it('should handle empty model catalog', () => {
      const compatible = getCompatibleModels(24, []);
      expect(Array.isArray(compatible)).toBe(true);
    });

    it('should handle undefined model catalog', () => {
      const compatible = getCompatibleModels(24, undefined);
      expect(Array.isArray(compatible)).toBe(true);
      expect(compatible.length).toBeGreaterThan(0);
    });
  });

  describe('Integration', () => {
    it('should find compatible models for detected VRAM', () => {
      const sysInfo = getSystemInfo();
      const compatibleModels = getCompatibleModels(sysInfo.gpu.vramGb);

      expect(Array.isArray(compatibleModels)).toBe(true);

      if (sysInfo.gpu.vramGb > 0) {
        expect(compatibleModels.length).toBeGreaterThan(0);
      }
    });

    it('should recommend tier based on detected VRAM', () => {
      const sysInfo = getSystemInfo();
      const recommendedTier = getRecommendedTier(sysInfo.gpu.vramGb);

      expect(typeof recommendedTier).toBe('number');
      expect(recommendedTier).toBeGreaterThanOrEqual(0);
      expect(recommendedTier).toBeLessThanOrEqual(5);
    });
  });

  describe('detectAppleSilicon (exported for testing)', () => {
    function makeHw(): Hardware {
      return { cpuCores: 8, ramGb: 32, gpuVramGb: 0, tier: 0, hasOllama: false };
    }

    it('detects M3 Ultra as tier 5 with 192GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M3 Ultra');
      expect(hw.tier).toBe(5);
      expect(hw.gpuVramGb).toBe(192);
    });

    it('detects M3 Max as tier 4 with 96GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M3 Max');
      expect(hw.tier).toBe(4);
      expect(hw.gpuVramGb).toBe(96); // Max + tier<5 = 96
    });

    it('detects M3 Pro as tier 4', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M3 Pro');
      expect(hw.tier).toBe(4);
      // Pro + tier>=3 = 48
      expect(hw.gpuVramGb).toBe(48);
    });

    it('detects M2 Ultra as tier 3 with 128GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M2 Ultra');
      expect(hw.tier).toBe(3);
      expect(hw.gpuVramGb).toBe(128);
    });

    it('detects M2 Max as tier 3 with 96GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M2 Max');
      expect(hw.tier).toBe(3);
      expect(hw.gpuVramGb).toBe(96);
    });

    it('detects M2 Pro as tier 2 with 18GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M2 Pro');
      expect(hw.tier).toBe(2);
      expect(hw.gpuVramGb).toBe(18);
    });

    it('detects M1 Ultra as tier 2 with 128GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M1 Ultra');
      expect(hw.tier).toBe(2);
      expect(hw.gpuVramGb).toBe(128);
    });

    it('detects M1 Max as tier 2 with 96GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M1 Max');
      expect(hw.tier).toBe(2);
      expect(hw.gpuVramGb).toBe(96);
    });

    it('detects M3 (base) as tier 1 with 10GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M3');
      expect(hw.tier).toBe(1);
      expect(hw.gpuVramGb).toBe(10);
    });

    it('detects M2 (base) as tier 1 with 10GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M2');
      expect(hw.tier).toBe(1);
      expect(hw.gpuVramGb).toBe(10);
    });

    it('detects M1 (base) as tier 1 with 10GB', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Apple M1');
      expect(hw.tier).toBe(1);
      expect(hw.gpuVramGb).toBe(10);
    });

    it('unknown model stays tier 0 with fallback VRAM 7', () => {
      const hw = makeHw();
      detectAppleSilicon(hw, 'Unknown CPU');
      expect(hw.tier).toBe(0);
      expect(hw.gpuVramGb).toBe(7);
    });
  });

  describe('detectNvidiaGPU (exported for testing)', () => {
    function makeHw(): Hardware {
      return { cpuCores: 8, ramGb: 32, gpuVramGb: 0, tier: 0, hasOllama: false };
    }

    it('parses GiB output', () => {
      const hw = makeHw();
      detectNvidiaGPU(hw, '24 GiB');
      expect(hw.gpuVramGb).toBe(24);
      expect(hw.tier).toBe(4);
    });

    it('parses MiB output', () => {
      const hw = makeHw();
      detectNvidiaGPU(hw, '16384 MiB');
      expect(hw.gpuVramGb).toBe(16);
      expect(hw.tier).toBe(3);
    });

    it('handles 80GB+ VRAM as tier 5', () => {
      const hw = makeHw();
      detectNvidiaGPU(hw, '80 GiB');
      expect(hw.tier).toBe(5);
    });

    it('handles 64GB VRAM as tier 5', () => {
      const hw = makeHw();
      detectNvidiaGPU(hw, '64 GiB');
      expect(hw.tier).toBe(5);
    });

    it('handles 10GB VRAM as tier 2', () => {
      const hw = makeHw();
      detectNvidiaGPU(hw, '10240 MiB');
      expect(hw.gpuVramGb).toBe(10);
      expect(hw.tier).toBe(2);
    });

    it('handles 6GB VRAM as tier 1', () => {
      const hw = makeHw();
      detectNvidiaGPU(hw, '6144 MiB');
      expect(hw.gpuVramGb).toBe(6);
      expect(hw.tier).toBe(1);
    });

    it('handles unrecognized output format', () => {
      const hw = makeHw();
      detectNvidiaGPU(hw, 'N/A');
      expect(hw.gpuVramGb).toBe(0);
      expect(hw.tier).toBe(0);
    });
  });

  describe('buildOsString', () => {
    it('returns macOS string for darwin', () => {
      expect(buildOsString('darwin', '24.0.0', 'arm64', 'Darwin')).toBe('macOS 24.0.0 (arm64)');
    });
    it('returns Linux string', () => {
      expect(buildOsString('linux', '6.1.0', 'x64', 'Linux')).toBe('Linux 6.1.0 (x64)');
    });
    it('returns Windows string', () => {
      expect(buildOsString('win32', '10.0', 'x64', 'Windows_NT')).toBe('Windows 10.0 (x64)');
    });
    it('returns fallback string for unknown platform', () => {
      expect(buildOsString('freebsd', '14.0', 'amd64', 'FreeBSD')).toBe('FreeBSD 14.0 (amd64)');
    });
  });

  describe('estimateAppleSiliconVram', () => {
    it('M3 Ultra → 192', () => expect(estimateAppleSiliconVram('Apple M3 Ultra')).toBe(192));
    it('M3 Max → 128', () => expect(estimateAppleSiliconVram('Apple M3 Max')).toBe(128));
    it('M2 Ultra → 128', () => expect(estimateAppleSiliconVram('Apple M2 Ultra')).toBe(128));
    it('M2 Max → 96', () => expect(estimateAppleSiliconVram('Apple M2 Max')).toBe(96));
    it('M3 Pro → 48', () => expect(estimateAppleSiliconVram('Apple M3 Pro')).toBe(48));
    it('M2 Pro → 18', () => expect(estimateAppleSiliconVram('Apple M2 Pro')).toBe(18));
    it('M1 Ultra → 128', () => expect(estimateAppleSiliconVram('Apple M1 Ultra')).toBe(128));
    it('M1 Max → 96', () => expect(estimateAppleSiliconVram('Apple M1 Max')).toBe(96));
    it('M3 base → 10', () => expect(estimateAppleSiliconVram('Apple M3')).toBe(10));
    it('M2 base → 10', () => expect(estimateAppleSiliconVram('Apple M2')).toBe(10));
    it('M1 base → 7', () => expect(estimateAppleSiliconVram('Apple M1')).toBe(7));
    it('Unknown → 0', () => expect(estimateAppleSiliconVram('Intel Core')).toBe(0));
  });

  describe('parseNvidiaSmiOutput', () => {
    it('parses name and GiB VRAM', () => {
      const result = parseNvidiaSmiOutput('NVIDIA RTX 4090, 24 GiB');
      expect(result.name).toBe('NVIDIA RTX 4090');
      expect(result.vramGb).toBe(24);
    });
    it('parses MiB VRAM', () => {
      const result = parseNvidiaSmiOutput('RTX 3060, 12288 MiB');
      expect(result.name).toBe('RTX 3060');
      expect(result.vramGb).toBe(12);
    });
    it('handles missing VRAM info', () => {
      const result = parseNvidiaSmiOutput('NVIDIA RTX 4090, N/A');
      expect(result.name).toBe('NVIDIA RTX 4090');
      expect(result.vramGb).toBe(0);
    });
    it('handles empty output', () => {
      const result = parseNvidiaSmiOutput('');
      expect(result.name).toBe('NVIDIA GPU'); // fallback
      expect(result.vramGb).toBe(0);
    });
    it('handles single column (name only)', () => {
      const result = parseNvidiaSmiOutput('NVIDIA RTX 4090');
      expect(result.name).toBe('NVIDIA RTX 4090');
      expect(result.vramGb).toBe(0);
    });
  });

  describe('getSystemInfo (real system)', () => {
    it('returns valid structure', () => {
      const info = getSystemInfo();
      expect(info).toHaveProperty('os');
      expect(info).toHaveProperty('cpu');
      expect(info).toHaveProperty('memory');
      expect(info).toHaveProperty('gpu');
      expect(typeof info.os).toBe('string');
      expect(typeof info.cpu.model).toBe('string');
      expect(typeof info.cpu.cores).toBe('number');
      expect(info.memory.totalGb).toBeGreaterThan(0);
    });
  });
});
