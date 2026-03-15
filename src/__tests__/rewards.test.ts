/**
 * Reward distribution tests (A12)
 */

import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

// Mock dependencies (solana, etc.)
const mockGetAccountInfo = jest.fn();
const mockConnection = {
  getAccountInfo: mockGetAccountInfo,
};

jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn(() => mockConnection),
  PublicKey: class {
    constructor(public value: string) {}
    static findProgramAddressSync: jest.Mock = jest.fn(() => ['mock-address' as any, 0]);
  },
}));

describe('rewards (A12)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateReward', () => {
    it('should calculate reward weight correctly', async () => {
      const { calculateRewardWeight } = await import('../rewards.js');

      const weight = calculateRewardWeight(100, 1000, 0.9);

      expect(weight).toBeCloseTo(0.09, 4); // 100/1000 * 0.9
    });

    it('should calculate reward with total pool', async () => {
      const { calculateReward } = await import('../rewards.js');

      const reward = calculateReward(100, 1000, 0.9, 10000);

      expect(reward).toBeCloseTo(900, 1); // 0.09 * 10000
    });

    it('should handle zero stake', async () => {
      const { calculateReward } = await import('../rewards.js');

      const reward = calculateReward(0, 1000, 0.9, 10000);

      expect(reward).toBe(0);
    });

    it('should handle zero network stake', async () => {
      const { calculateReward, calculateRewardWeight } = await import('../rewards.js');

      const weight = calculateRewardWeight(100, 0, 0.9);
      expect(weight).toBe(Infinity);

      const reward = calculateReward(100, 0, 0.9, 10000);
      expect(reward).toBe(Infinity);
    });
  });

  describe('calculateRewardBatch', () => {
    it('should distribute rewards to multiple peers', async () => {
      const { calculateRewardBatch } = await import('../rewards.js');

      const peers = [
        {
          peerId: 'peer-1',
          stakeInfo: { peerId: 'peer-1', stakedAmount: 100, tier: 1, stakeAccount: 'addr-1', lockupEndTimestamp: null },
          totalPulses: 100,
          successfulPulses: 90,
        },
        {
          peerId: 'peer-2',
          stakeInfo: { peerId: 'peer-2', stakedAmount: 500, tier: 2, stakeAccount: 'addr-2', lockupEndTimestamp: null },
          totalPulses: 100,
          successfulPulses: 95,
        },
        {
          peerId: 'peer-3',
          stakeInfo: { peerId: 'peer-3', stakedAmount: 1000, tier: 3, stakeAccount: 'addr-3', lockupEndTimestamp: null },
          totalPulses: 100,
          successfulPulses: 98,
        },
      ];

      const result = calculateRewardBatch(peers, 10000);

      expect(result.totalRewards).toBe(10000);
      expect(result.rewards).toHaveLength(3);
      expect(result.rewards[0].peerId).toBe('peer-1');
      expect(result.rewards[0].reward).toBeGreaterThan(0);
    });

    it('should handle empty peers', async () => {
      const { calculateRewardBatch } = await import('../rewards.js');

      const result = calculateRewardBatch([], 10000);

      expect(result.totalRewards).toBe(0);
      expect(result.rewards).toEqual([]);
    });

    it('should calculate validation scores correctly', async () => {
      const { calculateRewardBatch } = await import('../rewards.js');

      const peers = [
        {
          peerId: 'peer-1',
          stakeInfo: { peerId: 'peer-1', stakedAmount: 100, tier: 1, stakeAccount: 'addr-1', lockupEndTimestamp: null },
          totalPulses: 100,
          successfulPulses: 50,
        }, // 50% score
        {
          peerId: 'peer-2',
          stakeInfo: { peerId: 'peer-2', stakedAmount: 100, tier: 1, stakeAccount: 'addr-2', lockupEndTimestamp: null },
          totalPulses: 100,
          successfulPulses: 100,
        }, // 100% score
      ];

      const result = calculateRewardBatch(peers, 10000);

      // peer-2 should get more reward (higher validation score)
      expect(result.rewards[1].reward).toBeGreaterThan(result.rewards[0].reward);
    });
  });

  describe('calculateValidationScore', () => {
    it('should calculate validation score', async () => {
      const { calculateValidationScore } = await import('../rewards.js');

      const score = calculateValidationScore(100, 95); // 100 total, 95 successful

      expect(score).toBe(0.95);
    });

    it('should handle zero total pulses', async () => {
      const { calculateValidationScore } = await import('../rewards.js');

      const score = calculateValidationScore(0, 0);

      expect(score).toBe(0);
    });
  });

  describe('normalizeRewards', () => {
    it('should normalize rewards to total pool', async () => {
      const { normalizeRewards, calculateRewardBatch } = await import('../rewards.js');

      // First get valid RewardCalculation[]
      const peers = [
        { peerId: 'peer-1', stakeInfo: { peerId: 'peer-1', stakedAmount: 100, tier: 1, stakeAccount: 'addr-1', lockupEndTimestamp: null }, totalPulses: 100, successfulPulses: 90 },
        { peerId: 'peer-2', stakeInfo: { peerId: 'peer-2', stakedAmount: 500, tier: 2, stakeAccount: 'addr-2', lockupEndTimestamp: null }, totalPulses: 100, successfulPulses: 95 },
        { peerId: 'peer-3', stakeInfo: { peerId: 'peer-3', stakedAmount: 1000, tier: 3, stakeAccount: 'addr-3', lockupEndTimestamp: null }, totalPulses: 100, successfulPulses: 98 },
      ];

      const rewards = calculateRewardBatch(peers, 10000).rewards;

      // Now normalize to different pool size
      const normalized = normalizeRewards(rewards, 10000);

      // Sum of normalized rewards should equal new pool size
      const totalNormalized = normalized.reduce((sum, r) => sum + r.reward, 0);
      expect(totalNormalized).toBe(10000);
      expect(normalized).toHaveLength(3);
    });

    it('should handle empty rewards', async () => {
      const { normalizeRewards } = await import('../rewards.js');

      const normalized = normalizeRewards([], 10000);

      expect(normalized).toEqual([]);
    });

    it('should handle zero total pool', async () => {
      const { normalizeRewards } = await import('../rewards.js');

      const rewards = [
        { peerId: 'peer-1', stakedAmount: 100, validationScore: 1, tier: 1, weight: 1, reward: 500 },
      ];

      const normalized = normalizeRewards(rewards, 0);

      expect(normalized[0].reward).toBe(0);
    });
  });
});
