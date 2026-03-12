import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  detectHardware,
  getTierName,
  getSystemInfo,
  getCompatibleModels,
  getRecommendedTier,
} from '../hardware.js';
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
});
