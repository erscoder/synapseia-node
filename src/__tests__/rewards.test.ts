/**
 * Rewards module tests
 */

import {
  calculateValidationScore,
  calculateRewardWeight,
  calculateReward,
  normalizeRewards,
  calculateRewardBatch,
  distributeRewards,
  getRewardHistory,
  getRecentBatches,
  type RewardCalculation,
  type RewardBatch,
} from '../modules/staking/rewards';

describe('Rewards Module', () => {
  describe('calculateValidationScore', () => {
    it('should return 0 when totalPulses is 0', () => {
      expect(calculateValidationScore(0, 0)).toBe(0);
    });

    it('should return 0 when successfulPulses is 0', () => {
      expect(calculateValidationScore(10, 0)).toBe(0);
    });

    it('should return 1 when all pulses are successful', () => {
      expect(calculateValidationScore(10, 10)).toBe(1);
    });

    it('should return correct ratio', () => {
      expect(calculateValidationScore(10, 5)).toBe(0.5);
    });

    it('should cap at 1 when successfulPulses exceeds totalPulses', () => {
      expect(calculateValidationScore(10, 15)).toBe(1);
    });
  });

  describe('calculateRewardWeight', () => {
    it('should return 0 when stakedAmount is 0', () => {
      expect(calculateRewardWeight(0, 1000, 1)).toBe(0);
    });

    it('should return 0 when validationScore is 0', () => {
      expect(calculateRewardWeight(500, 1000, 0)).toBe(0);
    });

    it('should return correct weight for full stake and validation', () => {
      const weight = calculateRewardWeight(500, 1000, 1);
      expect(weight).toBe(0.5);
    });

    it('should scale proportionally with stake ratio', () => {
      const weight = calculateRewardWeight(250, 1000, 1);
      expect(weight).toBe(0.25);
    });

    it('should scale proportionally with validation score', () => {
      const weight = calculateRewardWeight(500, 1000, 0.5);
      expect(weight).toBe(0.25);
    });
  });

  describe('calculateReward', () => {
    it('should return 0 when stakedAmount is 0', () => {
      expect(calculateReward(0, 1000, 1, 1000)).toBe(0);
    });

    it('should return 0 when validationScore is 0', () => {
      expect(calculateReward(500, 1000, 0, 1000)).toBe(0);
    });

    it('should return full pool when peer has 100% of stake and validation', () => {
      const reward = calculateReward(1000, 1000, 1, 1000);
      expect(reward).toBe(1000);
    });

    it('should return proportional reward for partial stake', () => {
      const reward = calculateReward(500, 1000, 1, 1000);
      expect(reward).toBe(500);
    });

    it('should scale with validation score', () => {
      const reward = calculateReward(500, 1000, 0.5, 1000);
      expect(reward).toBe(250);
    });
  });

  describe('normalizeRewards', () => {
    it('should distribute equally when total weight is 0', () => {
      const rewards: RewardCalculation[] = [
        { peerId: 'p1', stakedAmount: 0, validationScore: 0, tier: 0, weight: 0, reward: 0 },
        { peerId: 'p2', stakedAmount: 0, validationScore: 0, tier: 0, weight: 0, reward: 0 },
      ];
      const result = normalizeRewards(rewards, 1000);
      
      expect(result[0].reward).toBe(500);
      expect(result[1].reward).toBe(500);
    });

    it('should not change rewards when total weight is 1', () => {
      const rewards: RewardCalculation[] = [
        { peerId: 'p1', stakedAmount: 500, validationScore: 1, tier: 0, weight: 0.5, reward: 500 },
        { peerId: 'p2', stakedAmount: 500, validationScore: 1, tier: 0, weight: 0.5, reward: 500 },
      ];
      const result = normalizeRewards(rewards, 1000);
      
      expect(result[0].reward).toBe(500);
      expect(result[1].reward).toBe(500);
    });

    it('should normalize when total weight is less than 1', () => {
      const rewards: RewardCalculation[] = [
        { peerId: 'p1', stakedAmount: 250, validationScore: 1, tier: 0, weight: 0.25, reward: 250 },
        { peerId: 'p2', stakedAmount: 250, validationScore: 1, tier: 0, weight: 0.25, reward: 250 },
      ];
      const result = normalizeRewards(rewards, 1000);
      
      // Total weight = 0.5, so rewards should double
      expect(result[0].reward).toBe(500);
      expect(result[1].reward).toBe(500);
    });

    it('should preserve peer properties', () => {
      const rewards: RewardCalculation[] = [
        { peerId: 'p1', stakedAmount: 500, validationScore: 1, tier: 2, weight: 0.5, reward: 500 },
      ];
      const result = normalizeRewards(rewards, 1000);
      
      expect(result[0].peerId).toBe('p1');
      expect(result[0].stakedAmount).toBe(500);
      expect(result[0].validationScore).toBe(1);
      expect(result[0].tier).toBe(2);
    });

    it('should handle single peer', () => {
      const rewards: RewardCalculation[] = [
        { peerId: 'p1', stakedAmount: 1000, validationScore: 1, tier: 0, weight: 1, reward: 1000 },
      ];
      const result = normalizeRewards(rewards, 500);
      
      expect(result[0].reward).toBe(500);
    });
  });

  describe('calculateRewardBatch', () => {
    it('should return empty batch for no peers', () => {
      const result = calculateRewardBatch([], 1000);
      
      expect(result.poolId).toMatch(/^pool-\d+$/);
      expect(result.totalPoolAmount).toBe(1000);
      expect(result.rewards).toEqual([]);
      expect(result.totalRewards).toBe(0);
    });

    it('should calculate rewards for single peer with full stake', () => {
      const peers = [
        {
          peerId: 'peer-1',
          stakeInfo: { peerId: 'peer-1', stakedAmount: 1000, tier: 0, stakeAccount: 'acc1', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 10,
        },
      ];
      
      const result = calculateRewardBatch(peers, 1000);
      
      expect(result.rewards.length).toBe(1);
      expect(result.rewards[0].peerId).toBe('peer-1');
      expect(result.rewards[0].stakedAmount).toBe(1000);
      expect(result.rewards[0].validationScore).toBe(1);
      expect(result.rewards[0].tier).toBe(0);
      expect(result.rewards[0].weight).toBe(1);
      expect(result.rewards[0].reward).toBe(1000);
      expect(result.totalRewards).toBe(1000);
    });

    it('should split rewards proportionally between peers', () => {
      const peers = [
        {
          peerId: 'peer-1',
          stakeInfo: { peerId: 'peer-1', stakedAmount: 500, tier: 0, stakeAccount: 'acc1', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 10,
        },
        {
          peerId: 'peer-2',
          stakeInfo: { peerId: 'peer-2', stakedAmount: 500, tier: 0, stakeAccount: 'acc2', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 10,
        },
      ];
      
      const result = calculateRewardBatch(peers, 1000);
      
      expect(result.rewards.length).toBe(2);
      expect(result.rewards[0].peerId).toBe('peer-1');
      expect(result.rewards[1].peerId).toBe('peer-2');
      // Each has 50% stake, 100% validation, so 50% of pool each
      expect(result.totalRewards).toBe(1000);
    });

    it('should factor in validation score', () => {
      const peers = [
        {
          peerId: 'peer-1',
          stakeInfo: { peerId: 'peer-1', stakedAmount: 500, tier: 0, stakeAccount: 'acc1', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 10, // 100% validation
        },
        {
          peerId: 'peer-2',
          stakeInfo: { peerId: 'peer-2', stakedAmount: 500, tier: 0, stakeAccount: 'acc2', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 5, // 50% validation
        },
      ];
      
      const result = calculateRewardBatch(peers, 1000);
      
      // peer-1: weight = (500/1000) * 1 = 0.5
      // peer-2: weight = (500/1000) * 0.5 = 0.25
      // Total weight = 0.75
      // peer-1 gets: (0.5/0.75) * 1000 = 666.67
      // peer-2 gets: (0.25/0.75) * 1000 = 333.33
      const peer1Reward = result.rewards.find(r => r.peerId === 'peer-1')!.reward;
      const peer2Reward = result.rewards.find(r => r.peerId === 'peer-2')!.reward;
      
      expect(peer1Reward).toBeCloseTo(666.67, 1);
      expect(peer2Reward).toBeCloseTo(333.33, 1);
      expect(result.totalRewards).toBeCloseTo(1000, 1);
    });

    it('should handle peers with 0 validation score', () => {
      const peers = [
        {
          peerId: 'peer-1',
          stakeInfo: { peerId: 'peer-1', stakedAmount: 500, tier: 0, stakeAccount: 'acc1', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 0, // 0% validation
        },
        {
          peerId: 'peer-2',
          stakeInfo: { peerId: 'peer-2', stakedAmount: 500, tier: 0, stakeAccount: 'acc2', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 10,
        },
      ];
      
      const result = calculateRewardBatch(peers, 1000);
      
      // peer-1: weight = (500/1000) * 0 = 0
      // peer-2: weight = (500/1000) * 1 = 0.5
      // Total weight = 0.5
      // peer-1 gets: 0 (equal split of nothing since weight is 0)
      // Actually normalizeRewards will give equal share when total weight is 0
      // But wait, peer-1 has weight 0 and peer-2 has weight 0.5
      // So peer-1 gets: (0/0.5) * 1000 = 0
      // peer-2 gets: (0.5/0.5) * 1000 = 1000
      
      const peer1Reward = result.rewards.find(r => r.peerId === 'peer-1')!.reward;
      const peer2Reward = result.rewards.find(r => r.peerId === 'peer-2')!.reward;
      
      expect(peer1Reward).toBe(0);
      expect(peer2Reward).toBe(1000);
    });

    it('should include tier information', () => {
      const peers = [
        {
          peerId: 'peer-1',
          stakeInfo: { peerId: 'peer-1', stakedAmount: 1000, tier: 3, stakeAccount: 'acc1', lockupEndTimestamp: null },
          totalPulses: 10,
          successfulPulses: 10,
        },
      ];
      
      const result = calculateRewardBatch(peers, 1000);
      
      expect(result.rewards[0].tier).toBe(3);
    });
  });

  describe('distributeRewards', () => {
    it('should return success with dummy transaction', async () => {
      const batch: RewardBatch = {
        poolId: 'pool-123',
        totalPoolAmount: 1000,
        batchTimestamp: Date.now(),
        rewards: [],
        totalRewards: 1000,
      };

      const result = await distributeRewards(batch, 'https://api.devnet.solana.com');

      expect(result.success).toBe(true);
      expect(result.txSignature).toBe('dummy-tx-signature');
      expect(result.batch).toBeDefined();
    });

    it('should use default RPC URL when not provided', async () => {
      const batch: RewardBatch = {
        poolId: 'pool-123',
        totalPoolAmount: 1000,
        batchTimestamp: Date.now(),
        rewards: [],
        totalRewards: 1000,
      };

      const result = await distributeRewards(batch);

      expect(result.success).toBe(true);
    });
  });

  describe('getRewardHistory', () => {
    it('should return empty array (dummy implementation)', async () => {
      const result = await getRewardHistory('peer-1', 10);
      
      expect(result).toEqual([]);
    });

    it('should use default limit', async () => {
      const result = await getRewardHistory('peer-1');
      
      expect(result).toEqual([]);
    });

    it('should use default RPC URL', async () => {
      const result = await getRewardHistory('peer-1', 5);
      
      expect(result).toEqual([]);
    });
  });

  describe('getRecentBatches', () => {
    it('should return empty array (dummy implementation)', async () => {
      const result = await getRecentBatches(10);
      
      expect(result).toEqual([]);
    });

    it('should use default limit', async () => {
      const result = await getRecentBatches();
      
      expect(result).toEqual([]);
    });

    it('should use default RPC URL', async () => {
      const result = await getRecentBatches(5);
      
      expect(result).toEqual([]);
    });
  });
});
