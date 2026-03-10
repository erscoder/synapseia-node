import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import axios from 'axios';
import { sendHeartbeat, startPeriodicHeartbeat, determineCapabilities } from '../heartbeat.js';

// Mock axios module
jest.mock('axios', () => ({
  create: jest.fn(),
}));

describe('heartbeat', () => {
  let postMock: any;

  beforeEach(() => {
    // Post mock setup for each test
    postMock = jest.fn();
    const mockInstance = {
      post: postMock,
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method
    (axios.create as jest.Mock).mockReturnValue(mockInstance);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('sends heartbeat with correct payload', async () => {
    const mockIdentity = {
      peerId: 'test-peer-id',
      privateKey: 'test-private-key',
      publicKey: 'test-public-key',
    };

    const mockHardware = {
      cpuCores: 10,
      ramGb: 16,
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: true,
    };

    const mockResponse = {
      data: {
        registered: true,
        peerId: 'test-peer-id',
      },
    };

    postMock.mockResolvedValue(mockResponse);

    const result = await sendHeartbeat('http://localhost:3001', mockIdentity, mockHardware);

    expect(result.registered).toBe(true);
    expect(result.peerId).toBe('test-peer-id');

    expect(postMock).toHaveBeenCalledWith(
      '/peer/heartbeat',
      {
        peerId: 'test-peer-id',
        walletAddress: null,
        tier: 0,
        capabilities: ['cpu', 'inference', 'embedding'],
        uptime: expect.any(Number),
      },
    );
  });

  it('retries on failure with exponential backoff', async () => {
    const mockIdentity = {
      peerId: 'test-peer-id',
      privateKey: 'test-private-key',
      publicKey: 'test-public-key',
    };

    const mockHardware = {
      cpuCores: 10,
      ramGb: 16,
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: true,
    };

    const mockResponse = {
      data: {
        registered: true,
        peerId: 'test-peer-id',
      },
    };

    postMock
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue(mockResponse);

    const result = await sendHeartbeat('http://localhost:3001', mockIdentity, mockHardware);

    expect(result.registered).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  it('throws after 3 failed attempts', async () => {
    const mockIdentity = {
      peerId: 'test-peer-id',
      privateKey: 'test-private-key',
      publicKey: 'test-public-key',
    };

    const mockHardware = {
      cpuCores: 10,
      ramGb: 16,
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: true,
    };

    postMock.mockRejectedValue(new Error('Network error'));

    await expect(
      sendHeartbeat('http://localhost:3001', mockIdentity, mockHardware),
    ).rejects.toThrow('Failed to send heartbeat after 3 attempts');

    expect(postMock).toHaveBeenCalledTimes(3);
  });

  it('determines capabilities based on hardware - CPU only', () => {
    const hardware = {
      cpuCores: 8,
      ramGb: 16,
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: false,
    };

    const capabilities = determineCapabilities(hardware);

    expect(capabilities).toEqual(['cpu']);
  });

  it('determines capabilities with inference', () => {
    const hardware = {
      cpuCores: 8,
      ramGb: 6, // Below 8GB, no embedding
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: true,
    };

    const capabilities = determineCapabilities(hardware);

    expect(capabilities).toEqual(['cpu', 'inference']);
  });

  it('determines capabilities with embedding (8GB+ RAM)', () => {
    const hardware = {
      cpuCores: 8,
      ramGb: 10,
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: true,
    };

    const capabilities = determineCapabilities(hardware);

    expect(capabilities).toEqual(['cpu', 'inference', 'embedding']);
  });

  it('starts periodic heartbeat and returns cleanup function', async () => {
    const mockIdentity = {
      peerId: 'test-peer-id',
      privateKey: 'test-private-key',
      publicKey: 'test-public-key',
    };

    const mockHardware = {
      cpuCores: 10,
      ramGb: 16,
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: true,
    };

    postMock.mockResolvedValue({ data: { registered: true, peerId: 'test-peer-id' } });

    jest.useFakeTimers();

    const cleanup = startPeriodicHeartbeat(
      'http://localhost:3001',
      mockIdentity,
      mockHardware,
      1000,
    );

    expect(typeof cleanup).toBe('function');

    jest.advanceTimersByTime(1000);

    expect(postMock).toHaveBeenCalled();

    cleanup();
    jest.useRealTimers();
  });

  it('handles errors in periodic heartbeat', async () => {
    const mockIdentity = {
      peerId: 'test-peer-id',
      privateKey: 'test-private-key',
      publicKey: 'test-public-key',
    };

    const mockHardware = {
      cpuCores: 10,
      ramGb: 16,
      gpuVramGb: 0,
      tier: 0 as const,
      hasOllama: true,
    };

    postMock.mockRejectedValue(new Error('Network failed'));

    jest.useFakeTimers();

    const cleanup = startPeriodicHeartbeat(
      'http://localhost:3001',
      mockIdentity,
      mockHardware,
      1000,
    );

    jest.advanceTimersByTime(1000);

    expect(postMock).toHaveBeenCalled();

    cleanup();
    jest.useRealTimers();
  });
});
