import { Injectable } from '@nestjs/common';
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
  type RewardDistributionResult,
} from '../../rewards.js';
import type { StakeInfo } from '../../staking.js';

@Injectable()
export class RewardsService {
  calculateValidationScore(totalPulses: number, successfulPulses: number): number {
    return calculateValidationScore(totalPulses, successfulPulses);
  }

  calculateWeight(stakedAmount: number, networkTotalStake: number, validationScore: number): number {
    return calculateRewardWeight(stakedAmount, networkTotalStake, validationScore);
  }

  calculateReward(
    stakedAmount: number,
    networkTotalStake: number,
    validationScore: number,
    totalPoolAmount: number,
  ): number {
    return calculateReward(stakedAmount, networkTotalStake, validationScore, totalPoolAmount);
  }

  normalize(rewards: RewardCalculation[], totalPoolAmount: number): RewardCalculation[] {
    return normalizeRewards(rewards, totalPoolAmount);
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
    return calculateRewardBatch(peers, totalPoolAmount);
  }

  distribute(batch: RewardBatch, rpcUrl?: string): Promise<RewardDistributionResult> {
    return distributeRewards(batch, rpcUrl);
  }

  getHistory(peerId: string, limit?: number, rpcUrl?: string): Promise<RewardCalculation[]> {
    return getRewardHistory(peerId, limit, rpcUrl);
  }

  getRecentBatches(limit?: number, rpcUrl?: string): Promise<RewardBatch[]> {
    return getRecentBatches(limit, rpcUrl);
  }
}
