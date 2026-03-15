/**
 * x86 hardware tests - separate module to test x86 paths
 * Mocking os differently at module load time
 */

import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// Mock os as x86 BEFORE importing hardware
jest.mock('os', () => ({
  cpus: () => [{ model: 'Intel Core i9' }],
  totalmem: () => 68719476736,
  platform: () => 'linux',
  release: () => '5.19.0',
  arch: () => 'x86_64',
  type: () => 'Linux',
}));

// Mock execSync for x86 GPU detection
const mockExecSync = jest.fn();
jest.mock('child_process', () => ({
  execSync: mockExecSync,
}));

describe('hardware x86 paths (A13)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('24 GiB');
  });

  describe('detectHardware - x86 arch', () => {
    it('should detect NVIDIA GPU on x86', async () => {
      const hardware = await import('../hardware.js');

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('ollama')) throw new Error('Not installed');
        return '24 GiB';
      });

      const detected = hardware.detectHardware();

      expect(detected.tier).toBeGreaterThan(0);
      expect(detected.gpuVramGb).toBeGreaterThan(0);
    });
  });

  describe('getSystemInfo - x86 with NVIDIA', () => {
    it('should detect NVIDIA GPU in system info', async () => {
      const hardware = await import('../hardware.js');

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('nvidia-smi')) return 'NVIDIA GeForce RTX 3090, 24 GiB';
        if (cmd.includes('ollama')) throw new Error('Not installed');
        throw new Error('Unknown command');
      });

      const info = hardware.getSystemInfo();

      expect(info.gpu.type).toContain('NVIDIA');
      expect(info.gpu.vramGb).toBeGreaterThan(0);
    });
  });
});
