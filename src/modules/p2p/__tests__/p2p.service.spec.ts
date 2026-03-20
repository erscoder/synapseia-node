import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../p2p.js', () => ({
  createP2PNode: jest.fn(),
  TOPICS: {
    HEARTBEAT: '/synapseia/heartbeat/1.0.0',
    SUBMISSION: '/synapseia/submission/1.0.0',
    LEADERBOARD: '/synapseia/leaderboard/1.0.0',
    PULSE: '/synapseia/pulse/1.0.0',
  },
}));

import * as p2pHelper from '../../../p2p.js';
import { P2pService } from '../p2p.service.js';

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

describe('P2pService', () => {
  let service: P2pService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new P2pService();
  });

  it('createNode() delegates to createP2PNode with defaults', async () => {
    const mockNode = { start: jest.fn(), stop: jest.fn() };
    (p2pHelper.createP2PNode as jest.Mock<any>).mockResolvedValue(mockNode);
    const result = await service.createNode(mockIdentity as any);
    expect(p2pHelper.createP2PNode).toHaveBeenCalledWith(mockIdentity, []);
    expect(result).toBe(mockNode);
  });

  it('createNode() passes bootstrap addresses', async () => {
    const mockNode = { start: jest.fn() };
    (p2pHelper.createP2PNode as jest.Mock<any>).mockResolvedValue(mockNode);
    await service.createNode(mockIdentity as any, ['/ip4/1.2.3.4/tcp/4001']);
    expect(p2pHelper.createP2PNode).toHaveBeenCalledWith(mockIdentity, ['/ip4/1.2.3.4/tcp/4001']);
  });

  it('topics getter returns TOPICS constant', () => {
    const topics = service.topics;
    expect(topics).toBe(p2pHelper.TOPICS);
    expect(topics.HEARTBEAT).toBe('/synapseia/heartbeat/1.0.0');
  });
});
