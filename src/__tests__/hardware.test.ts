/**
 * Hardware detection tests (A13)
 */

import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

// Mock execSync to avoid real hardware calls
const mockExecSync = jest.fn();
const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  execSync: mockExecSync,
  spawnSync: mockSpawnSync,
}));

// Mock os
jest.mock('os', () => ({
  cpus: () => [{ model: 'Apple M3 Max' }],
  totalmem: () => 17179869184,
  platform: () => 'darwin',
  release: () => '23.0.0',
  arch: () => 'arm64',
  type: () => 'Darwin',
}));

describe('hardware (A13)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Default spawnSync mock. Individual tests override as needed.
    // Returns a valid SpawnSyncReturns shape so destructuring never fails.
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined });
    // Process-lifetime cache must be reset per test or mocks from one
    // case leak into the next via the cached Hardware object.
    const { resetHardwareCache } = await import('../modules/hardware/hardware.js');
    resetHardwareCache();
  });

  describe('detectHardware', () => {
    it('should detect Apple Silicon hardware', async () => {
      const { detectHardware } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockReturnValue('Apple M3 Max');

      const hardware = detectHardware();

      expect(hardware).toBeDefined();
      expect(hardware.cpuCores).toBeGreaterThan(0);
      expect(hardware.ramGb).toBeGreaterThan(0);
      expect(hardware.hasOllama).toBeDefined();
    });

    it.skip('should detect GPU V-RAM for compatible GPUs', async () => {
      const { detectHardware } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockImplementation((cmd: any) => {
        if (cmd.includes('sysctl')) return 'Apple M3 Max';
        if (cmd.includes('ollama')) throw new Error('Not installed');
      });

      const hardware = detectHardware();

      // Apple M3 Max should have GPU
      expect(hardware.gpuVramGb).toBeGreaterThan(0);
      expect(hardware.hardwareClass).toBeGreaterThan(0);
    });

    it('should handle CPU-only mode', async () => {
      const { detectHardware } = await import('../modules/hardware/hardware.js');

      const hardware = detectHardware(true);

      expect(hardware).toBeDefined();
      expect(hardware.cpuCores).toBeGreaterThan(0);
      expect(hardware.gpuVramGb).toBe(0); // CPU-only mode
    });

    it.skip('should handle x86 arch with archOverride parameter', async () => {
      const { detectHardware } = await import('../modules/hardware/hardware.js');

      // Mock nvidia-smi response
      mockExecSync.mockImplementation((cmd: any) => {
        if (cmd.includes('nvidia-smi')) return '24 GiB';
        if (cmd.includes('ollama')) throw new Error('Not installed');
        return '';
      });

      const hardware = detectHardware(false, 'x86');

      expect(hardware.hardwareClass).toBe(4); // 24GB V-RAM → tier 4
      expect(hardware.gpuVramGb).toBe(24);
    });

    it.skip('should handle arm64 arch with archOverride parameter', async () => {
      const { detectHardware } = await import('../modules/hardware/hardware.js');

      mockExecSync.mockReturnValue('Apple M3 Max');

      const hardware = detectHardware(false, 'arm64');

      expect(hardware.hardwareClass).toBe(4);
      expect(hardware.gpuVramGb).toBe(96);
    });

    it.skip('should set hasOllama false when curl fails', async () => {
      const { detectHardware } = await import('../modules/hardware/hardware.js');

      mockExecSync.mockImplementation((cmd: any) => {
        if (cmd.includes('sysctl')) return 'Apple M3 Max';
        if (cmd.includes('curl')) throw new Error('Not installed');
        return '';
      });

      const hardware = detectHardware();

      expect(hardware.hasOllama).toBe(false);
    });

    describe('OLLAMA_URL + cloud LLM env handling', () => {
      const savedEnv = {
        OLLAMA_URL: process.env.OLLAMA_URL,
        LLM_CLOUD_MODEL: process.env.LLM_CLOUD_MODEL,
        LLM_PROVIDER: process.env.LLM_PROVIDER,
      };

      afterEach(() => {
        process.env.OLLAMA_URL = savedEnv.OLLAMA_URL;
        process.env.LLM_CLOUD_MODEL = savedEnv.LLM_CLOUD_MODEL;
        process.env.LLM_PROVIDER = savedEnv.LLM_PROVIDER;
      });

      it('honors OLLAMA_URL env when probing the daemon (e.g. docker sibling http://ollama:11434)', async () => {
        const { detectHardware } = await import('../modules/hardware/hardware.js');
        process.env.OLLAMA_URL = 'http://ollama:11434';
        delete process.env.LLM_CLOUD_MODEL;
        delete process.env.LLM_PROVIDER;

        let spawnCmd: string | undefined;
        let spawnArgs: string[] | undefined;
        mockExecSync.mockImplementation((cmd: any) => {
          if (typeof cmd === 'string' && cmd.includes('sysctl')) return 'Apple M3 Max';
          return '';
        });
        mockSpawnSync.mockImplementation((cmd: any, args: any) => {
          if (cmd === 'curl') {
            spawnCmd = cmd;
            spawnArgs = args;
            return { status: 0, error: undefined }; // success — mimics 200 OK
          }
          return { status: 1, error: undefined };
        });

        const hardware = detectHardware();

        expect(spawnCmd).toBe('curl');
        expect(spawnArgs).toContain('http://ollama:11434/api/tags');
        expect(spawnArgs?.some((a) => a.includes('localhost'))).toBe(false);
        expect(hardware.hasOllama).toBe(true);
      });

      it('sets hasCloudLlm=true when LLM_CLOUD_MODEL env is set', async () => {
        const { detectHardware } = await import('../modules/hardware/hardware.js');
        process.env.LLM_CLOUD_MODEL = 'minimax/MiniMax-M2.7';
        delete process.env.LLM_PROVIDER;
        delete process.env.OLLAMA_URL;

        mockExecSync.mockImplementation((cmd: any) => {
          if (typeof cmd === 'string' && cmd.includes('sysctl')) return 'Apple M3 Max';
          return '';
        });
        mockSpawnSync.mockImplementation((cmd: any) => {
          if (cmd === 'curl') return { status: 1, error: new Error('ECONNREFUSED') };
          return { status: 1, error: undefined };
        });

        const hardware = detectHardware();

        expect(hardware.hasCloudLlm).toBe(true);
        expect(hardware.hasOllama).toBe(false);
      });

      it('sets hasCloudLlm=true when LLM_PROVIDER=cloud', async () => {
        const { detectHardware } = await import('../modules/hardware/hardware.js');
        delete process.env.LLM_CLOUD_MODEL;
        process.env.LLM_PROVIDER = 'cloud';
        delete process.env.OLLAMA_URL;

        mockExecSync.mockImplementation((cmd: any) => {
          if (typeof cmd === 'string' && cmd.includes('sysctl')) return 'Apple M3 Max';
          return '';
        });
        mockSpawnSync.mockImplementation((cmd: any) => {
          if (cmd === 'curl') return { status: 1, error: new Error('ECONNREFUSED') };
          return { status: 1, error: undefined };
        });

        const hardware = detectHardware();

        expect(hardware.hasCloudLlm).toBe(true);
      });

      it('sets hasCloudLlm=false when neither env var is set', async () => {
        const { detectHardware } = await import('../modules/hardware/hardware.js');
        delete process.env.LLM_CLOUD_MODEL;
        delete process.env.LLM_PROVIDER;
        delete process.env.OLLAMA_URL;

        mockExecSync.mockImplementation((cmd: any) => {
          if (typeof cmd === 'string' && cmd.includes('sysctl')) return 'Apple M3 Max';
          return '';
        });
        mockSpawnSync.mockImplementation((cmd: any) => {
          if (cmd === 'curl') return { status: 1, error: new Error('ECONNREFUSED') };
          return { status: 1, error: undefined };
        });

        const hardware = detectHardware();

        expect(hardware.hasCloudLlm).toBe(false);
      });
    });
  });

  describe('detectNvidiaGPU', () => {
    it('should update hardware with NVIDIA metadata from GiB', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 16,
        ramGb: 64,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectNvidiaGPU(hardware, '24 GiB');

      expect(hardware.gpuVramGb).toBe(24);
      expect(hardware.hardwareClass).toBe(4);
    });

    it('should update hardware with NVIDIA metadata from MiB', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectNvidiaGPU(hardware, '8192 MiB');

      expect(hardware.gpuVramGb).toBe(8);
    });

    it.skip('should call execSync when smiOutput is undefined', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockReturnValue('24 GiB');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectNvidiaGPU(hardware, undefined);

      expect(mockExecSync).toHaveBeenCalled();
      expect(hardware.gpuVramGb).toBe(24);
    });

    it('should handle non-GiB/MiB output gracefully', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectNvidiaGPU(hardware, 'Unknown format');

      expect(hardware.gpuVramGb).toBe(0);
    });
  });

  describe('getRecommendedTier', () => {
    it('should recommend tier based on V-RAM', async () => {
      const { getRecommendedTier } = await import('../modules/hardware/hardware.js');

      expect(getRecommendedTier(0)).toBe(0); // No GPU
      expect(getRecommendedTier(8)).toBe(2); // 8GB V-RAM → tier 2 (≥6)
      expect(getRecommendedTier(16)).toBe(4); // 16GB V-RAM → tier 4 (≥16)
      expect(getRecommendedTier(24)).toBe(4); // 24GB V-RAM → tier 4
      expect(getRecommendedTier(48)).toBe(5); // 48GB V-RAM → tier 5
      expect(getRecommendedTier(80)).toBe(5); // 80GB V-RAM → tier 5
    });
  });

  describe('getTierName', () => {
    it('should return correct tier names', async () => {
      const { getTierName } = await import('../modules/hardware/hardware.js');

      expect(getTierName(0)).toBe('CPU-Only');
      expect(getTierName(1)).toBe('Tier 1');
      expect(getTierName(2)).toBe('Tier 2');
      expect(getTierName(3)).toBe('Tier 3');
      expect(getTierName(4)).toBe('Tier 4');
      expect(getTierName(5)).toBe('Tier 5');
    });
  });

  describe('estimateAppleSiliconVram', () => {
    it('should estimate V-RAM for Apple Silicon models', async () => {
      const { estimateAppleSiliconVram } = await import('../modules/hardware/hardware.js');

      expect(estimateAppleSiliconVram('Apple M3 Max')).toBe(128);
      expect(estimateAppleSiliconVram('Apple M3 Pro')).toBe(48);
      expect(estimateAppleSiliconVram('Apple M3 Ultra')).toBe(192);
      expect(estimateAppleSiliconVram('Apple M2 Ultra')).toBe(128);
      expect(estimateAppleSiliconVram('Apple M2 Max')).toBe(96);
    });

    it('should return 0 for unknown models', async () => {
      const { estimateAppleSiliconVram } = await import('../modules/hardware/hardware.js');

      expect(estimateAppleSiliconVram('Unknown GPU')).toBe(0);
    });
  });

  describe('parseNvidiaSmiOutput', () => {
    it('should parse nvidia-smi output', async () => {
      const { parseNvidiaSmiOutput } = await import('../modules/hardware/hardware.js');

      const output = 'NVIDIA GeForce RTX 3090, 24 GiB';
      const result = parseNvidiaSmiOutput(output);

      expect(result.name).toBe('NVIDIA GeForce RTX 3090');
      expect(result.vramGb).toBe(24);
    });

    it('should parse MiB format', async () => {
      const { parseNvidiaSmiOutput } = await import('../modules/hardware/hardware.js');

      const output = 'NVIDIA RTX 4070, 8192 MiB';
      const result = parseNvidiaSmiOutput(output);

      expect(result.name).toBe('NVIDIA RTX 4070');
      expect(result.vramGb).toBe(8);
    });
  });

  describe('detectAppleSilicon', () => {
    it('should update hardware with Apple Silicon metadata', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 12,
        ramGb: 64,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M3 Max');

      expect(hardware.gpuVramGb).toBe(96); // M3 Max tier 4 → Max with tier != 5
      expect(hardware.hardwareClass).toBe(4);
    });

    it('should handle unknown models (default to M1)', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M1 Unknown'); // Matches 'M1' pattern

      expect(hardware.gpuVramGb).toBe(10); // M1 tier 1 → tier === 1 → 10
      expect(hardware.hardwareClass).toBe(1);
    });

    it('should handle M2 Ultra', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M2 Ultra');

      expect(hardware.gpuVramGb).toBe(128);
      expect(hardware.hardwareClass).toBe(3);
    });

    it('should handle M2 Max', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M2 Max');

      expect(hardware.gpuVramGb).toBe(96); // Max with tier 3
      expect(hardware.hardwareClass).toBe(3);
    });

    it('should handle M1 Ultra', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M1 Ultra');

      expect(hardware.gpuVramGb).toBe(128);
      expect(hardware.hardwareClass).toBe(2);
    });

    it('should handle M1 Max', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M1 Max');

      expect(hardware.gpuVramGb).toBe(96);
      expect(hardware.hardwareClass).toBe(2);
    });

    it('should handle M3 Ultra', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M3 Ultra');

      expect(hardware.gpuVramGb).toBe(192); // Ultra tier 5 → 192
      expect(hardware.hardwareClass).toBe(5);
    });

    it('should handle M3 Pro', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M3 Pro');

      expect(hardware.gpuVramGb).toBe(48); // Pro tier 0 → 18, tier >=3 → 48
    });

    it('should handle M2 (no suffix)', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');

      const hardware = {
        cpuCores: 8,
        ramGb: 32,
        gpuVramGb: 0,
        hardwareClass: 0,
        hasOllama: false,
      };

      detectAppleSilicon(hardware, 'Apple M2');

      expect(hardware.gpuVramGb).toBe(10); // M2 tier=1 → else branch tier===1 → 10
      expect(hardware.hardwareClass).toBe(1);
    });

    // Note: Max models always get tier=4 or 3, so tier===5 in Max VRAM assignment was dead code
    // Refactored to always assign 96 GB for Max models
  });

  describe('getCompatibleModels', () => {
    it('should filter models by V-RAM', async () => {
      const { getCompatibleModels } = await import('../modules/hardware/hardware.js');

      const allModels = [
        { name: 'Model A', minVram: 1 },
        { name: 'Model B', minVram: 8 },
        { name: 'Model C', minVram: 32 },
      ] as any[];

      const compatible = getCompatibleModels(16, allModels);

      expect(compatible).toHaveLength(2);
      expect(compatible[0].name).toBe('Model A');
      expect(compatible[1].name).toBe('Model B');
    });

    it('should use default catalog if none provided', async () => {
      const { getCompatibleModels } = await import('../modules/hardware/hardware.js');

      const compatible = getCompatibleModels(999);

      expect(compatible.length).toBeGreaterThan(0);
    });
  });

  describe('buildOsString', () => {
    it('should build macOS string', async () => {
      const { buildOsString } = await import('../modules/hardware/hardware.js');

      const osStr = buildOsString('darwin', '23.0.0', 'arm64', 'Darwin');

      expect(osStr).toContain('macOS');
      expect(osStr).toContain('arm64');
    });

    it('should build Linux string', async () => {
      const { buildOsString } = await import('../modules/hardware/hardware.js');

      const osStr = buildOsString('linux', '5.19.0', 'x86_64', 'Linux');

      expect(osStr).toContain('Linux');
      expect(osStr).toContain('x86_64');
    });

    it('should build Windows string', async () => {
      const { buildOsString } = await import('../modules/hardware/hardware.js');

      const osStr = buildOsString('win32', '10.0.0', 'x64', 'WindowsNT');

      expect(osStr).toContain('Windows');
      expect(osStr).toContain('x64');
    });

    it('should handle default OS type', async () => {
      const { buildOsString } = await import('../modules/hardware/hardware.js');

      const osStr = buildOsString('other', '1.0.0', 'mips', 'UnknownOS');

      expect(osStr).toContain('UnknownOS');
      expect(osStr).toContain('mips');
    });
  });

  describe('getSystemInfo', () => {
    it('should return system info', async () => {
      const { getSystemInfo } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockImplementation((cmd: any) => {
        if (cmd.includes('sysctl')) return 'Apple M3 Max';
        throw new Error('nvidia-smi not found');
      });

      const info = getSystemInfo();

      expect(info).toBeDefined();
      expect(info.os).toBeDefined();
      expect(info.cpu).toBeDefined();
      expect(info.memory).toBeDefined();
      expect(info.gpu).toBeDefined();
    });

    it('should handle detection errors gracefully', async () => {
      const { getSystemInfo } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockImplementation(() => {
        throw new Error('Detection failed');
      });

      const info = getSystemInfo();

      expect(info.gpu.vramGb).toBe(0);
      expect(info.gpu.type).toBeNull();
    });

    it.skip('should detect x86_64 GPU with archOverride', async () => {
      const { getSystemInfo } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockReturnValue('NVIDIA GeForce RTX 3090, 24 GiB');

      const info = getSystemInfo('x86_64');

      expect(info.gpu.type).toContain('NVIDIA');
      expect(info.gpu.vramGb).toBe(24);
    });

    it.skip('should detect x64 GPU with archOverride', async () => {
      const { getSystemInfo } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockReturnValue('NVIDIA GeForce RTX 4090, 24 GiB');

      const info = getSystemInfo('x64');

      expect(info.gpu.type).toContain('NVIDIA');
      expect(info.gpu.vramGb).toBe(24);
    });
  });

  describe('detectAppleSilicon nested ternary coverage', () => {
    it('Ultra: tier===5 → 192', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 5, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple M3 Ultra');
      expect(hardware.gpuVramGb).toBe(192);
    });

    it('Ultra: tier!==5 → 128', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 3, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple M2 Ultra');
      expect(hardware.gpuVramGb).toBe(128);
    });

    it('Max: always 96 GB (tier===5 was dead code)', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 5, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple M3 Max');
      expect(hardware.gpuVramGb).toBe(96);
    });

    it('Pro: tier>=3 → 48', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 4, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple M3 Pro');
      expect(hardware.gpuVramGb).toBe(48);
    });

    it('Pro: M2 Pro (tier=2) → 18 from tier<3 branch', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 0, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple M2 Pro'); // M2 Pro sets tier=2, then tier<3 gives 18
      expect(hardware.hardwareClass).toBe(2);
      expect(hardware.gpuVramGb).toBe(18);
    });

    it('Pro: tier<3 → 18', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 2, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple M2 Pro');
      expect(hardware.gpuVramGb).toBe(18);
    });

    it('Else: tier===1 → 10', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 1, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple M1');
      expect(hardware.gpuVramGb).toBe(10);
    });

    it('Else: tier!==1 → 7', async () => {
      const { detectAppleSilicon } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 2, hasOllama: false };
      detectAppleSilicon(hardware, 'Apple UnknownModel'); // No matches → else with tier stays 2
      expect(hardware.gpuVramGb).toBe(7);
    });
  });

  describe('detectNvidiaGPU tier adjustments', () => {
    it('should set tier 5 for >=80GB VRAM', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 0, hasOllama: false };
      detectNvidiaGPU(hardware, '81920 MiB'); // 80GB = 81920 MiB
      expect(hardware.hardwareClass).toBe(5);
    });

    it('should set tier 5 for >=64GB VRAM', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 0, hasOllama: false };
      detectNvidiaGPU(hardware, '65536 MiB');
      expect(hardware.hardwareClass).toBe(5);
    });

    it('should set tier 4 for >=24GB VRAM when tier<5', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 4, hasOllama: false };
      detectNvidiaGPU(hardware, '24576 MiB');
      expect(hardware.hardwareClass).toBe(4);
    });

    it('should keep existing tier 5 when >=24GB', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 5, hasOllama: false };
      detectNvidiaGPU(hardware, '24576 MiB');
      expect(hardware.hardwareClass).toBe(5);
    });

    it('should set tier 3 for >=14GB VRAM when tier<4', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 3, hasOllama: false };
      detectNvidiaGPU(hardware, '14336 MiB');
      expect(hardware.hardwareClass).toBe(3);
    });

    it('should set tier 2 for >=10GB VRAM when tier<3', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 2, hasOllama: false };
      detectNvidiaGPU(hardware, '10240 MiB');
      expect(hardware.hardwareClass).toBe(2);
    });

    it('should set tier 1 for >=6GB VRAM when tier<2', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 0, hardwareClass: 1, hasOllama: false };
      detectNvidiaGPU(hardware, '6144 MiB');
      expect(hardware.hardwareClass).toBe(1);
    });
  });

  describe('getTierName edge cases', () => {
    it('should return Unknown for out of range tier', async () => {
      const { getTierName } = await import('../modules/hardware/hardware.js');
      expect(getTierName(6 as any)).toBe('Unknown');
      expect(getTierName(-1 as any)).toBe('Unknown');
    });
  });

  // Note: os.cpus() null coalescing branches are unreachable in mocked environment
  // Node.js never returns undefined/null from os.cpus() in real systems

  describe('estimateAppleSiliconVram full coverage', () => {
    it('should cover all model branches', async () => {
      const { estimateAppleSiliconVram } = await import('../modules/hardware/hardware.js');
      expect(estimateAppleSiliconVram('Apple M3 Pro')).toBe(48);
      expect(estimateAppleSiliconVram('Apple M2 Pro')).toBe(18);
      expect(estimateAppleSiliconVram('Apple M1 Ultra')).toBe(128);
      expect(estimateAppleSiliconVram('Apple M1 Max')).toBe(96);
      expect(estimateAppleSiliconVram('Apple M3')).toBe(10);
      expect(estimateAppleSiliconVram('Apple M2')).toBe(10);
      expect(estimateAppleSiliconVram('Apple M1')).toBe(7);
      expect(estimateAppleSiliconVram('Unknown Model')).toBe(0);
    });
  });

  describe('parseNvidiaSmiOutput edge cases', () => {
    it('should handle whitespace-only input (returns default)', async () => {
      const { parseNvidiaSmiOutput } = await import('../modules/hardware/hardware.js');
      const result = parseNvidiaSmiOutput('   \n  ');
      expect(result.name).toBe('NVIDIA GPU'); // Default when parsing fails
      expect(result.vramGb).toBe(0);
    });

    it('should handle truly empty lines', async () => {
      const { parseNvidiaSmiOutput } = await import('../modules/hardware/hardware.js');
      const result = parseNvidiaSmiOutput(''); // Empty after trim/split returns empty array? NO, returns ['']
      expect(result.name).toBe('NVIDIA GPU'); // Current implementation behavior
      expect(result.vramGb).toBe(0);
    });
  });

  // getSystemInfo os.cpus() branch unreachable in tests

  describe('getRecommendedTier coverage', () => {
    it('should cover all VRAM thresholds', async () => {
      const { getRecommendedTier } = await import('../modules/hardware/hardware.js');
      expect(getRecommendedTier(80)).toBe(5);
      expect(getRecommendedTier(64)).toBe(5);
      expect(getRecommendedTier(24)).toBe(4);
      expect(getRecommendedTier(16)).toBe(4);
      expect(getRecommendedTier(14)).toBe(3);
      expect(getRecommendedTier(10)).toBe(3);
      expect(getRecommendedTier(6)).toBe(2);
      expect(getRecommendedTier(1)).toBe(1);
      expect(getRecommendedTier(0)).toBe(0);
      expect(getRecommendedTier(0.5)).toBe(0);
    });
  });

  describe('cache + pre-flight (Windows hang fix)', () => {
    it('detectHardware caches the result across calls (same object reference)', async () => {
      const { detectHardware } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockReturnValue('Apple M3 Max');

      const first = detectHardware();
      const second = detectHardware();

      // Same reference proves the cache hit. A re-probe would build a
      // fresh object via the object-literal at the top of detectHardware.
      expect(second).toBe(first);
    });

    it('detectHardware re-probes after resetHardwareCache()', async () => {
      const { detectHardware, resetHardwareCache } = await import(
        '../modules/hardware/hardware.js'
      );
      mockExecSync.mockReturnValue('Apple M3 Max');

      const first = detectHardware();
      resetHardwareCache();
      const second = detectHardware();

      // Distinct object identity confirms the cache was bypassed.
      expect(second).not.toBe(first);
      // Value still matches because the mock is unchanged.
      expect(second.gpuVramGb).toBe(first.gpuVramGb);
    });

    it('detectNvidiaGPU returns silently when nvidia-smi is not on PATH (no execSync spawn)', async () => {
      const { detectNvidiaGPU } = await import('../modules/hardware/hardware.js');
      const savedPath = process.env.PATH;
      const savedWinPath = process.env.Path;
      // Force PATH to a directory that cannot contain nvidia-smi so the
      // pre-flight check fails. /tmp is safe on POSIX runners; on Win
      // hosts CI never exercises this test file (mocked arch=arm64) but
      // we clear Path defensively too.
      process.env.PATH = '/tmp';
      delete process.env.Path;
      try {
        const hardware = {
          cpuCores: 8,
          ramGb: 32,
          gpuVramGb: 0,
          hardwareClass: 0,
          hasOllama: false,
        };

        detectNvidiaGPU(hardware);

        // No execSync invocation when the binary is missing.
        expect(mockExecSync).not.toHaveBeenCalled();
        // Hardware stays at the default no-GPU state.
        expect(hardware.gpuVramGb).toBe(0);
        expect(hardware.hardwareClass).toBe(0);
      } finally {
        process.env.PATH = savedPath;
        if (savedWinPath !== undefined) process.env.Path = savedWinPath;
      }
    });

    it('detectNvidiaGPU still parses gpuVramGb=0 cleanly from existing "nvidia-smi not found" mock flow', async () => {
      // Preserves the historical test at hardware.test.ts:577 — when
      // execSync throws "nvidia-smi not found" mid-detection, the
      // outer try/catch in detectHardware swallows it and we get a
      // clean Hardware object with gpuVramGb=0.
      const { detectHardware } = await import('../modules/hardware/hardware.js');
      mockExecSync.mockImplementation((cmd: any) => {
        if (typeof cmd === 'string' && cmd.includes('sysctl')) {
          throw new Error('nvidia-smi not found');
        }
        return '';
      });

      const hardware = detectHardware();

      expect(hardware.gpuVramGb).toBe(0);
      expect(hardware.hardwareClass).toBe(0);
    });
  });
});
