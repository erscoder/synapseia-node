import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { HeartbeatHelper } from '../../heartbeat';
import { HeartbeatService } from '../heartbeat.service';

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
  let heartbeatHelper: jest.Mocked<HeartbeatHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        HeartbeatService,
        {
          provide: HeartbeatHelper,
          useValue: {
            sendHeartbeat: jest.fn(),
            startPeriodicHeartbeat: jest.fn(),
            determineCapabilities: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<HeartbeatService>(HeartbeatService);
    heartbeatHelper = module.get(HeartbeatHelper);
    jest.clearAllMocks();
  });

  it('send() delegates to heartbeatHelper.sendHeartbeat', async () => {
    const mockResponse = { success: true };
    (heartbeatHelper.sendHeartbeat as jest.Mock<any>).mockResolvedValue(mockResponse);
    const result = await service.send('http://localhost:3001', mockIdentity as any, mockHardware as any);
    expect(heartbeatHelper.sendHeartbeat).toHaveBeenCalledWith('http://localhost:3001', mockIdentity, mockHardware);
    expect(result).toBe(mockResponse);
  });

  it('startPeriodic() delegates to heartbeatHelper.startPeriodicHeartbeat with 60s default (Tier 3 §3.C.2)', () => {
    const cleanup = jest.fn();
    (heartbeatHelper.startPeriodicHeartbeat as jest.Mock<any>).mockReturnValue(cleanup);
    const result = service.startPeriodic('http://localhost:3001', mockIdentity as any, mockHardware as any);
    expect(heartbeatHelper.startPeriodicHeartbeat).toHaveBeenCalledWith(
      'http://localhost:3001',
      mockIdentity,
      mockHardware,
      60000,
      undefined,
    );
    expect(result).toBe(cleanup);
  });

  it('startPeriodic() passes custom intervalMs and p2pNode', () => {
    const cleanup = jest.fn();
    const mockP2P = {} as any;
    (heartbeatHelper.startPeriodicHeartbeat as jest.Mock<any>).mockReturnValue(cleanup);
    service.startPeriodic('http://localhost:3001', mockIdentity as any, mockHardware as any, 60000, mockP2P);
    expect(heartbeatHelper.startPeriodicHeartbeat).toHaveBeenCalledWith(
      'http://localhost:3001',
      mockIdentity,
      mockHardware,
      60000,
      mockP2P,
    );
  });

  it('determineCapabilities() delegates to heartbeatHelper.determineCapabilities', () => {
    (heartbeatHelper.determineCapabilities as jest.Mock<any>).mockReturnValue(['cpu', 'inference']);
    const result = service.determineCapabilities(mockHardware as any);
    expect(heartbeatHelper.determineCapabilities).toHaveBeenCalledWith(mockHardware);
    expect(result).toEqual(['cpu', 'inference']);
  });
});
