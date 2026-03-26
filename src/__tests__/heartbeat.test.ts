/**
 * Heartbeat tests (A14)
 * Tests for sendHeartbeat, startPeriodicHeartbeat, determineCapabilities
 */

import { jest } from '@jest/globals';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Create mock functions before importing
const mockPost = jest.fn();

// Mock axios module - setup before import
jest.mock('axios', () => {
  const mockCreate = jest.fn(() => ({
    post: mockPost,
  }));
  return {
    default: {
      create: mockCreate,
    },
    create: mockCreate,
  };
});

import axios from 'axios';
import { sendHeartbeat, startPeriodicHeartbeat, determineCapabilities } from '../modules/heartbeat/heartbeat.js';

describe('heartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPost.mockReset();
  });

  it('sends heartbeat with correct payload', async () => {
    const mockIdentity = {
      createdAt: 1234567890,
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

    mockPost.mockResolvedValue(mockResponse);

    const result = await sendHeartbeat('http://localhost:3701', mockIdentity, mockHardware);

    expect(result.registered).toBe(true);
    expect(mockPost).toHaveBeenCalledWith(
      '/heartbeat',
      expect.objectContaining({
        peerId: 'test-peer-id',
        capabilities: expect.any(Array),
      })
    );
  });

  it('retries on failure with exponential backoff', async () => {
    const mockIdentity = {
      createdAt: 1234567890,
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

    mockPost
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ data: { registered: true, peerId: 'test-peer-id' } });

    const result = await sendHeartbeat('http://localhost:3701', mockIdentity, mockHardware);

    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(result.registered).toBe(true);
  });

  it('throws after 3 failed attempts', async () => {
    const mockIdentity = {
      createdAt: 1234567890,
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

    mockPost.mockRejectedValue(new Error('Network error'));

    await expect(
      sendHeartbeat('http://localhost:3701', mockIdentity, mockHardware)
    ).rejects.toThrow('Network error');

    expect(mockPost).toHaveBeenCalledTimes(3);
  });

  describe('determineCapabilities', () => {
    it('determines capabilities based on hardware - CPU only', () => {
      const hardware = {
        cpuCores: 4,
        ramGb: 8,
        gpuVramGb: 0,
        tier: 0 as const,
        hasOllama: false,
      };

      const capabilities = determineCapabilities(hardware);

      expect(capabilities).toContain('training');
      expect(capabilities).toContain('research');
    });

    it('determines capabilities with inference', () => {
      const hardware = {
        cpuCores: 4,
        ramGb: 8,
        gpuVramGb: 0,
        tier: 0 as const,
        hasOllama: true,
      };

      const capabilities = determineCapabilities(hardware);

      expect(capabilities).toContain('inference');
    });

    it('determines capabilities with embedding (8GB+ RAM)', () => {
      const hardware = {
        cpuCores: 8,
        ramGb: 16,
        gpuVramGb: 0,
        tier: 0 as const,
        hasOllama: true,
      };

      const capabilities = determineCapabilities(hardware);

      expect(capabilities).toContain('embedding');
    });
  });

  describe('startPeriodicHeartbeat', () => {
    it('starts periodic heartbeat with default interval', async () => {
      const mockIdentity = {
        createdAt: 1234567890,
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

      mockPost.mockResolvedValue({ data: { registered: true } });

      const stop = startPeriodicHeartbeat('http://localhost:3701', mockIdentity, mockHardware);
      
      // Wait a bit for at least one heartbeat
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(mockPost).toHaveBeenCalled();
      
      // Stop the heartbeat
      stop();
      
      const callCount = mockPost.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Should not make more calls after stop
      expect(mockPost.mock.calls.length).toBe(callCount);
    });

    it('starts periodic heartbeat and returns cleanup function', () => {
      const mockIdentity = {
        createdAt: 1234567890,
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

      mockPost.mockResolvedValue({ data: { registered: true } });

      const stop = startPeriodicHeartbeat('http://localhost:3701', mockIdentity, mockHardware, 1000);
      
      expect(typeof stop).toBe('function');
      
      stop();
    });

    it('handles errors in periodic heartbeat', async () => {
      const mockIdentity = {
        createdAt: 1234567890,
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

      // First call succeeds, then fails
      mockPost
        .mockResolvedValueOnce({ data: { registered: true } })
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockResolvedValue({ data: { registered: true } });

      const stop = startPeriodicHeartbeat('http://localhost:3701', mockIdentity, mockHardware, 50);
      
      // Wait for multiple heartbeats
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Should have retried after error
      expect(mockPost).toHaveBeenCalledTimes(3);
      
      stop();
    });
  });
});