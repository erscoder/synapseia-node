import { Injectable } from '@nestjs/common';
import { RewardsHelper, type RewardCalculation, type RewardBatch, type RewardDistributionResult } from './helpers/rewards.js';
import type { StakeInfo } from './helpers/staking.js';

@Injectable()
export class RewardsService {
  constructor(private readonly rewardsHelper: RewardsHelper) {}

  calculateValidationScore(totalPulses: number, successfulPulses: number): number {
    return this.rewardsHelper.calculateValidationScore(totalPulses, successfulPulses);
  }

  calculateWeight(stakedAmount: number, networkTotalStake: number, validationScore: number): number {
    return this.rewardsHelper.calculateRewardWeight(stakedAmount, networkTotalStake, validationScore);
  }

  calculateReward(
    stakedAmount: number,
    networkTotalStake: number,
    validationScore: number,
    totalPoolAmount: number,
  ): number {
    return this.rewardsHelper.calculateReward(stakedAmount, networkTotalStake, validationScore, totalPoolAmount);
  }

  normalize(rewards: RewardCalculation[], totalPoolAmount: number): RewardCalculation[] {
    return this.rewardsHelper.normalizeRewards(rewards, totalPoolAmount);
  }

  calculateBatch(
    peers: Array<{
      peerId: string;
      stakeInfo: StakeInfo;
      totalPulses: number;
      successfulPulses: number;
    }>,
    totalPoolAmount: number,
  ): RewardBatch {
    return this.rewardsHelper.calculateRewardBatch(peers, totalPoolAmount);
  }

  distribute(batch: RewardBatch, rpcUrl?: string): Promise<RewardDistributionResult> {
    return this.rewardsHelper.distributeRewards(batch, rpcUrl);
  }

  getHistory(peerId: string, limit?: number, rpcUrl?: string): Promise<RewardCalculation[]> {
    return this.rewardsHelper.getRewardHistory(peerId, limit, rpcUrl);
  }

  getRecentBatches(limit?: number, rpcUrl?: string): Promise<RewardBatch[]> {
    return this.rewardsHelper.getRecentBatches(limit, rpcUrl);
  }
}
