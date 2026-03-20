import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../heartbeat.js', () => ({
  sendHeartbeat: jest.fn(),
  startPeriodicHeartbeat: jest.fn(),
  determineCapabilities: jest.fn(),
}));

import * as hbHelper from '../../../heartbeat.js';
import { HeartbeatService } from '../heartbeat.service.js';

const mockIdentity = {
  peerId: 'peer-1',
  publicKey: 'pubkey',
  privateKey: 'privkey',
  createdAt: 1000,
  agentId: 'agent01',
  tier: 0,
  mode: 'chill' as const,
  status: 'idle' as const,
};

const mockHardware = {
  arch: 'arm64' as const,
  cpuCores: 8,
  ramGb: 16,
  vramGb: 0,
  isOllamaRunning: false,
  tier: 1,
  tierName: 'standard',
};

describe('HeartbeatService', () => {
  let service: HeartbeatService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HeartbeatService();
  });

  it('send() delegates to sendHeartbeat', async () => {
    const mockResponse = { success: true };
    (hbHelper.sendHeartbeat as jest.Mock<any>).mockResolvedValue(mockResponse);
    const result = await service.send('http://localhost:3001', mockIdentity as any, mockHardware as any);
    expect(hbHelper.sendHeartbeat).toHaveBeenCalledWith('http://localhost:3001', mockIdentity, mockHardware);
    expect(result).toBe(mockResponse);
  });

  it('startPeriodic() delegates to startPeriodicHeartbeat with defaults', () => {
    const cleanup = jest.fn();
    (hbHelper.startPeriodicHeartbeat as jest.Mock<any>).mockReturnValue(cleanup);
    const result = service.startPeriodic('http://localhost:3001', mockIdentity as any, mockHardware as any);
    expect(hbHelper.startPeriodicHeartbeat).toHaveBeenCalledWith(
      'http://localhost:3001',
      mockIdentity,
      mockHardware,
      30000,
      undefined,
    );
    expect(result).toBe(cleanup);
  });

  it('startPeriodic() passes custom intervalMs and p2pNode', () => {
    const cleanup = jest.fn();
    const mockP2P = {} as any;
    (hbHelper.startPeriodicHeartbeat as jest.Mock<any>).mockReturnValue(cleanup);
    service.startPeriodic('http://localhost:3001', mockIdentity as any, mockHardware as any, 60000, mockP2P);
    expect(hbHelper.startPeriodicHeartbeat).toHaveBeenCalledWith(
      'http://localhost:3001',
      mockIdentity,
      mockHardware,
      60000,
      mockP2P,
    );
  });

  it('determineCapabilities() delegates to determineCapabilities', () => {
    (hbHelper.determineCapabilities as jest.Mock<any>).mockReturnValue(['cpu', 'inference']);
    const result = service.determineCapabilities(mockHardware as any);
    expect(hbHelper.determineCapabilities).toHaveBeenCalledWith(mockHardware);
    expect(result).toEqual(['cpu', 'inference']);
  });
});
