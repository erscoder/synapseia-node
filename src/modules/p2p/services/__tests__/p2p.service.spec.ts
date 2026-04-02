import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { P2pHelper, TOPICS } from '../../p2p';
import { P2pService } from '../p2p.service';

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
  let p2pHelper: jest.Mocked<P2pHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        P2pService,
        {
          provide: P2pHelper,
          useValue: {
            createP2PNode: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<P2pService>(P2pService);
    p2pHelper = module.get(P2pHelper);
  });

  it('createNode() delegates to p2pHelper.createP2PNode with defaults', async () => {
    const mockNode = { start: jest.fn(), stop: jest.fn() };
    p2pHelper.createP2PNode.mockResolvedValue(mockNode as any);
    const result = await service.createNode(mockIdentity as any);
    expect(p2pHelper.createP2PNode).toHaveBeenCalledWith(mockIdentity, []);
    expect(result).toBe(mockNode);
  });

  it('createNode() passes bootstrap addresses', async () => {
    const mockNode = { start: jest.fn() };
    p2pHelper.createP2PNode.mockResolvedValue(mockNode as any);
    await service.createNode(mockIdentity as any, ['/ip4/1.2.3.4/tcp/4001']);
    expect(p2pHelper.createP2PNode).toHaveBeenCalledWith(mockIdentity, ['/ip4/1.2.3.4/tcp/4001']);
  });

  it('topics getter returns TOPICS constant', () => {
    const topics = service.topics;
    expect(topics).toBe(TOPICS);
    expect(topics.HEARTBEAT).toBe('/synapseia/heartbeat/1.0.0');
  });
});
