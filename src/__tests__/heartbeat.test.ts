import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import axios from 'axios';
import { sendHeartbeat } from '../heartbeat.js';

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
});
