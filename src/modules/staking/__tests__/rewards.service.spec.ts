import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { RewardsHelper } from '../../../rewards.js';
import { RewardsService } from '../rewards.service.js';

const mockBatch = {
  id: 'batch-1',
  rewards: [],
  totalPool: 1000,
  timestamp: Date.now(),
};

describe('RewardsService', () => {
  let service: RewardsService;
  let rewardsHelper: jest.Mocked<RewardsHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        RewardsService,
        {
          provide: RewardsHelper,
          useValue: {
            calculateValidationScore: jest.fn(),
            calculateRewardWeight: jest.fn(),
            calculateReward: jest.fn(),
            normalizeRewards: jest.fn(),
            calculateRewardBatch: jest.fn(),
            distributeRewards: jest.fn(),
            getRewardHistory: jest.fn(),
            getRecentBatches: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RewardsService>(RewardsService);
    rewardsHelper = module.get(RewardsHelper);
  });

  it('calculateValidationScore() delegates to calculateValidationScore', () => {
    rewardsHelper.calculateValidationScore.mockReturnValue(0.95);
    const result = service.calculateValidationScore(100, 95);
    expect(rewardsHelper.calculateValidationScore).toHaveBeenCalledWith(100, 95);
    expect(result).toBe(0.95);
  });

  it('calculateWeight() delegates to calculateRewardWeight', () => {
    rewardsHelper.calculateRewardWeight.mockReturnValue(0.05);
    const result = service.calculateWeight(500, 10000, 0.95);
    expect(rewardsHelper.calculateRewardWeight).toHaveBeenCalledWith(500, 10000, 0.95);
    expect(result).toBe(0.05);
  });

  it('calculateReward() delegates to calculateReward', () => {
    rewardsHelper.calculateReward.mockReturnValue(47.5);
    const result = service.calculateReward(500, 10000, 0.95, 1000);
    expect(rewardsHelper.calculateReward).toHaveBeenCalledWith(500, 10000, 0.95, 1000);
    expect(result).toBe(47.5);
  });

  it('normalize() delegates to normalizeRewards', () => {
    const rewards = [{ peerId: 'p1', reward: 50 }];
    const normalized = [{ peerId: 'p1', reward: 50 }];
    rewardsHelper.normalizeRewards.mockReturnValue(normalized as any);
    const result = service.normalize(rewards as any, 1000);
    expect(rewardsHelper.normalizeRewards).toHaveBeenCalledWith(rewards, 1000);
    expect(result).toBe(normalized);
  });

  it('calculateBatch() delegates to calculateRewardBatch', () => {
    rewardsHelper.calculateRewardBatch.mockReturnValue(mockBatch as any);
    const peers = [{ peerId: 'p1', stakeInfo: { stakedAmount: 100 }, totalPulses: 50, successfulPulses: 48 }];
    const result = service.calculateBatch(peers as any, 1000);
    expect(rewardsHelper.calculateRewardBatch).toHaveBeenCalledWith(peers, 1000);
    expect(result).toBe(mockBatch);
  });

  it('distribute() delegates to distributeRewards', async () => {
    const distResult = { success: true, txIds: ['tx1'] };
    rewardsHelper.distributeRewards.mockResolvedValue(distResult as any);
    const result = await service.distribute(mockBatch as any);
    expect(rewardsHelper.distributeRewards).toHaveBeenCalledWith(mockBatch, undefined);
    expect(result).toBe(distResult);
  });

  it('distribute() passes rpcUrl', async () => {
    rewardsHelper.distributeRewards.mockResolvedValue({ success: true } as any);
    await service.distribute(mockBatch as any, 'https://rpc.solana.com');
    expect(rewardsHelper.distributeRewards).toHaveBeenCalledWith(mockBatch, 'https://rpc.solana.com');
  });

  it('getHistory() delegates to getRewardHistory', async () => {
    const history = [{ peerId: 'p1', reward: 50 }];
    rewardsHelper.getRewardHistory.mockResolvedValue(history as any);
    const result = await service.getHistory('peer-1');
    expect(rewardsHelper.getRewardHistory).toHaveBeenCalledWith('peer-1', undefined, undefined);
    expect(result).toBe(history);
  });

  it('getHistory() passes limit and rpcUrl', async () => {
    rewardsHelper.getRewardHistory.mockResolvedValue([]);
    await service.getHistory('peer-1', 10, 'https://rpc.solana.com');
    expect(rewardsHelper.getRewardHistory).toHaveBeenCalledWith('peer-1', 10, 'https://rpc.solana.com');
  });

  it('getRecentBatches() delegates to getRecentBatches', async () => {
    rewardsHelper.getRecentBatches.mockResolvedValue([mockBatch] as any);
    const result = await service.getRecentBatches();
    expect(rewardsHelper.getRecentBatches).toHaveBeenCalledWith(undefined, undefined);
    expect(result).toEqual([mockBatch]);
  });

  it('getRecentBatches() passes limit and rpcUrl', async () => {
    rewardsHelper.getRecentBatches.mockResolvedValue([]);
    await service.getRecentBatches(5, 'https://rpc.solana.com');
    expect(rewardsHelper.getRecentBatches).toHaveBeenCalledWith(5, 'https://rpc.solana.com');
  });
});
