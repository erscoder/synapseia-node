/**
 * Heartbeat tests (A14)
 * Tests for HeartbeatHelper.sendHeartbeat, startPeriodicHeartbeat, determineCapabilities
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { HeartbeatHelper } from '../modules/heartbeat/heartbeat';
import { IpifyService } from '../modules/shared/infrastructure/ipify.service';

const mockPost: any = jest.fn();

jest.mock('axios', () => {
  const mockCreate = jest.fn(() => ({
    post: mockPost,
  }));
  return {
    default: { create: mockCreate },
    create: mockCreate,
  };
});

const mockResolvePublicIp = jest.fn<() => Promise<string>>();

jest.mock('../modules/shared/infrastructure/ipify.service', () => ({
  IpifyService: jest.fn().mockImplementation(() => ({
    resolvePublicIp: mockResolvePublicIp,
  })),
}));

jest.mock('../modules/model/trainer', () => ({
  isPyTorchAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
}));

describe('HeartbeatHelper', () => {
  let helper: HeartbeatHelper;
  const mockIpifyService = new IpifyService() as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPost.mockReset();
    mockResolvePublicIp.mockResolvedValue('1.2.3.4');
    helper = new HeartbeatHelper(mockIpifyService);
  });

  describe('determineCapabilities', () => {
    it('determines capabilities for CPU-only hardware', () => {
      const hardware = {
        cpuCores: 4,
        ramGb: 8,
        gpuVramGb: 0,
        hardwareClass: 0 as const,
        hasOllama: false,
        hasCloudLlm: false,
      };

      const capabilities = helper.determineCapabilities(hardware);

      expect(capabilities).toContain('cpu_training');
      expect(capabilities).toContain('cpu_inference');
      expect(capabilities).not.toContain('inference');
      expect(capabilities).not.toContain('embedding');
      expect(capabilities).not.toContain('gpu_training');
    });

    it('determines capabilities with Ollama inference', () => {
      const hardware = {
        cpuCores: 4,
        ramGb: 8,
        gpuVramGb: 0,
        hardwareClass: 0 as const,
        hasOllama: true,
        hasCloudLlm: false,
      };

      const capabilities = helper.determineCapabilities(hardware);

      expect(capabilities).toContain('cpu_training');
      expect(capabilities).toContain('cpu_inference');
      expect(capabilities).toContain('inference');
      expect(capabilities).toContain('llm');
      expect(capabilities).toContain('embedding'); // hasOllama && ramGb >= 8
    });

    it('determines capabilities with embedding (8GB+ RAM)', () => {
      const hardware = {
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        hardwareClass: 0 as const,
        hasOllama: true,
        hasCloudLlm: false,
      };

      const capabilities = helper.determineCapabilities(hardware);

      expect(capabilities).toContain('embedding');
      expect(capabilities).toContain('inference');
    });

    it('determines capabilities with GPU training', () => {
      const hardware = {
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 8,
        hardwareClass: 1 as const,
        hasOllama: false,
        hasCloudLlm: false,
      };

      const capabilities = helper.determineCapabilities(hardware);

      expect(capabilities).toContain('gpu_training');
      expect(capabilities).toContain('cpu_training');
    });

    it('determines capabilities with cloud LLM', () => {
      const hardware = {
        cpuCores: 4,
        ramGb: 8,
        gpuVramGb: 0,
        hardwareClass: 0 as const,
        hasOllama: false,
        hasCloudLlm: true,
      };

      const capabilities = helper.determineCapabilities(hardware);

      expect(capabilities).toContain('inference');
      expect(capabilities).toContain('llm');
    });
  });

  describe('sendHeartbeat', () => {
    const mockIdentity = {
      createdAt: 1234567890,
      peerId: 'test-peer-id',
      privateKey: 'test-private-key',
      publicKey: 'test-public-key',
      name: 'TestNode',
    };

    const mockHardware = {
      cpuCores: 10,
      ramGb: 16,
      gpuVramGb: 0,
      hardwareClass: 0 as const,
      hasOllama: true,
      hasCloudLlm: false,
    };

    it('sends heartbeat with correct payload', async () => {
      mockPost.mockResolvedValue({ data: { registered: true, peerId: 'test-peer-id' } });

      const result = await helper.sendHeartbeat(
        'http://localhost:3701',
        mockIdentity,
        mockHardware,
      );

      expect(result.registered).toBe(true);
      expect(mockPost).toHaveBeenCalledWith(
        '/peer/heartbeat',
        expect.objectContaining({
          peerId: 'test-peer-id',
          publicKey: 'test-public-key',
          capabilities: expect.any(Array),
        })
      );
    });

    it('propagates GPU vram + gpuModel to the coordinator payload', async () => {
      // Regression guard: previously the payload omitted these fields so the
      // coordinator's `nodes.vram` column stayed null even on machines with
      // a real GPU. The heartbeat now must echo hardware.gpuVramGb / gpuModel.
      mockPost.mockResolvedValue({ data: { registered: true, peerId: 'test-peer-id' } });

      const gpuHardware = {
        ...mockHardware,
        gpuVramGb: 18,
        gpuModel: 'Apple M1 Pro',
      };

      await helper.sendHeartbeat('http://localhost:3701', mockIdentity, gpuHardware);

      expect(mockPost).toHaveBeenCalledWith(
        '/peer/heartbeat',
        expect.objectContaining({
          vram: 18,
          gpuModel: 'Apple M1 Pro',
        }),
      );
    });

    it('retries on failure with exponential backoff', async () => {
      mockPost
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({ data: { registered: true, peerId: 'test-peer-id' } });

      const result = await helper.sendHeartbeat(
        'http://localhost:3701',
        mockIdentity,
        mockHardware,
      );

      expect(mockPost).toHaveBeenCalledTimes(3);
      expect(result.registered).toBe(true);
    });

    it('throws after 3 failed attempts', async () => {
      mockPost.mockRejectedValue(new Error('Network error'));

      await expect(
        helper.sendHeartbeat('http://localhost:3701', mockIdentity, mockHardware)
      ).rejects.toThrow('Failed to send heartbeat after 3 attempts');

      expect(mockPost).toHaveBeenCalledTimes(3);
    });

    it('includes geo coordinates when provided', async () => {
      mockPost.mockResolvedValue({ data: { registered: true } });

      await helper.sendHeartbeat(
        'http://localhost:3701',
        mockIdentity,
        mockHardware,
        40.4168,
        -3.7038,
      );

      expect(mockPost).toHaveBeenCalledWith(
        '/peer/heartbeat',
        expect.objectContaining({
          lat: 40.4168,
          lng: -3.7038,
        })
      );
    });

    it('includes wallet address when provided', async () => {
      mockPost.mockResolvedValue({ data: { registered: true } });

      await helper.sendHeartbeat(
        'http://localhost:3701',
        mockIdentity,
        mockHardware,
        undefined,
        undefined,
        '0x1234567890abcdef',
      );

      expect(mockPost).toHaveBeenCalledWith(
        '/peer/heartbeat',
        expect.objectContaining({
          walletAddress: '0x1234567890abcdef',
        })
      );
    });

    /* ─────────── BETA_LIMIT_REACHED handling (S2) ─────────── */

    describe('beta-limit cap (403 BETA_LIMIT_REACHED)', () => {
      let exitSpy: jest.SpiedFunction<typeof process.exit>;
      let stderrSpy: jest.SpiedFunction<typeof console.error>;

      beforeEach(() => {
        // Capture process.exit() so the test can assert the call without
        // actually terminating Jest. We throw a sentinel so the surrounding
        // retry loop unwinds (mirrors how the real CLI process would die).
        exitSpy = jest
          .spyOn(process, 'exit')
          .mockImplementation((code?: number | string | null) => {
            throw new Error(`__exit:${code}`);
          }) as any;
        stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      });

      afterEach(() => {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
      });

      it('exits 0 with marker line when coord returns 403 BETA_LIMIT_REACHED', async () => {
        const err: any = new Error('Request failed with status code 403');
        err.response = {
          status: 403,
          data: {
            statusCode: 403,
            error: 'Forbidden',
            code: 'BETA_LIMIT_REACHED',
            message: 'Beta tester limit reached. Synapseia will be available on mainnet soon.',
            limit: 5,
            current: 5,
          },
        };
        mockPost.mockRejectedValue(err);

        await expect(
          helper.sendHeartbeat('http://localhost:3701', mockIdentity, mockHardware),
        ).rejects.toThrow('__exit:0');

        // Exit called exactly once with code 0 — expected state, not crash.
        expect(exitSpy).toHaveBeenCalledWith(0);

        // Marker line must appear verbatim on stderr (node-ui parses
        // it with /^\[BETA_LIMIT_REACHED\]/m).
        const stderrLines = stderrSpy.mock.calls.map(args => String(args[0] ?? ''));
        expect(stderrLines).toContain('[BETA_LIMIT_REACHED]');
        expect(stderrLines.some(l => l.includes('Beta tester limit reached'))).toBe(true);
        expect(stderrLines.some(l => l.includes('Current: 5/5 nodes registered.'))).toBe(true);

        // No retry — exit happens on the first attempt.
        expect(mockPost).toHaveBeenCalledTimes(1);
      });

      it('does NOT trigger limit handler when 403 has different code', async () => {
        // Generic 403 (e.g. deny-list, sig invalid) must fall through to the
        // normal retry path, not silently exit. Coord returns 403 for several
        // reasons; only `code === 'BETA_LIMIT_REACHED'` is the cap.
        const err: any = new Error('Forbidden');
        err.response = {
          status: 403,
          data: { statusCode: 403, error: 'Forbidden', code: 'OTHER' },
        };
        mockPost.mockRejectedValue(err);

        await expect(
          helper.sendHeartbeat('http://localhost:3701', mockIdentity, mockHardware),
        ).rejects.toThrow('Failed to send heartbeat after 3 attempts');

        expect(exitSpy).not.toHaveBeenCalled();
        expect(mockPost).toHaveBeenCalledTimes(3);
      });

      it('does not invoke limit handler on a successful 200 response', async () => {
        mockPost.mockResolvedValue({ data: { registered: true, peerId: 'test-peer-id' } });

        const result = await helper.sendHeartbeat(
          'http://localhost:3701',
          mockIdentity,
          mockHardware,
        );

        expect(result.registered).toBe(true);
        expect(exitSpy).not.toHaveBeenCalled();
      });
    });
  });
});
