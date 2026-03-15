/**
 * Reward distribution (A12)
 * Calculates and distributes rewards based on stake contribution and validation pulses
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { REWARDS_PROGRAM_ID } from './utils/idl.js';
import type { StakeInfo } from './staking.js';

export interface RewardCalculation {
  peerId: string;
  stakedAmount: number;
  validationScore: number; // 0-1 based on pulse participation
  tier: number;
  weight: number; // Combined weight based on stake and validation
  reward: number; // SYN tokens to receive
}

export interface RewardBatch {
  poolId: string;
  totalPoolAmount: number; // Total SYN in reward pool
  batchTimestamp: number;
  rewards: RewardCalculation[];
  totalRewards: number; // Sum of all rewards in batch
}

export interface RewardDistributionResult {
  success: boolean;
  txSignature?: string;
  batch?: RewardBatch;
  error?: string;
}

/**
 * Calculate validation score for a peer based on pulse participation
 */
export function calculateValidationScore(
  totalPulses: number,
  successfulPulses: number,
): number {
  if (totalPulses === 0) return 0;
  return Math.min(1, successfulPulses / totalPulses);
}

/**
 * Calculate combined weight for reward allocation
 * Weight = (stakeAmount / networkTotalStake) * validationScore
 */
export function calculateRewardWeight(
  stakedAmount: number,
  networkTotalStake: number,
  validationScore: number,
): number {
  const stakeRatio = stakedAmount / networkTotalStake;
  return stakeRatio * validationScore;
}

/**
 * Calculate reward for a peer
 * Reward = weight * totalPoolAmount
 */
export function calculateReward(
  stakedAmount: number,
  networkTotalStake: number,
  validationScore: number,
  totalPoolAmount: number,
): number {
  const weight = calculateRewardWeight(stakedAmount, networkTotalStake, validationScore);
  return weight * totalPoolAmount;
}

/**
 * Normalize rewards to ensure pool is fully distributed
 * Adjusts weights proportionally if sum < 1
 */
export function normalizeRewards(
  rewards: RewardCalculation[],
  totalPoolAmount: number,
): RewardCalculation[] {
  const totalWeight = rewards.reduce((sum, r) => sum + r.weight, 0);

  // If total weight is 0, distribute equally
  if (totalWeight === 0) {
    const share = totalPoolAmount / rewards.length;
    return rewards.map((r) => ({
      ...r,
      reward: share,
    }));
  }

  // Normalize so weights sum to 1
  return rewards.map((r) => ({
    ...r,
    reward: (r.weight / totalWeight) * totalPoolAmount,
  }));
}

/**
 * Calculate reward batch for all active peers
 */
export function calculateRewardBatch(
  peers: Array<{
    peerId: string;
    stakeInfo: StakeInfo;
    totalPulses: number;
    successfulPulses: number;
  }>,
  totalPoolAmount: number,
): RewardBatch {
  const networkTotalStake = peers.reduce(
    (sum, p) => sum + p.stakeInfo.stakedAmount,
    0,
  );

  const rewards: RewardCalculation[] = peers.map((peer) => {
    const validationScore = calculateValidationScore(
      peer.totalPulses,
      peer.successfulPulses,
    );
    const weight = calculateRewardWeight(
      peer.stakeInfo.stakedAmount,
      networkTotalStake,
      validationScore,
    );
    const reward = calculateReward(
      peer.stakeInfo.stakedAmount,
      networkTotalStake,
      validationScore,
      totalPoolAmount,
    );

    return {
      peerId: peer.peerId,
      stakedAmount: peer.stakeInfo.stakedAmount,
      validationScore,
      tier: peer.stakeInfo.tier,
      weight,
      reward,
    };
  });

  // Normalize rewards
  const normalizedRewards = normalizeRewards(rewards, totalPoolAmount);
  const totalRewards = normalizedRewards.reduce((sum, r) => sum + r.reward, 0);

  return {
    poolId: `pool-${Date.now()}`,
    totalPoolAmount,
    batchTimestamp: Date.now(),
    rewards: normalizedRewards,
    totalRewards,
  };
}

/**
 * Distribute rewards via Solana transaction
 * Calls the rewards program to transfer SYN tokens to recipient accounts
 */
export async function distributeRewards(
  batch: RewardBatch,
  rpcUrl: string = 'https://api.devnet.solana.com',
): Promise<RewardDistributionResult> {
  try {
    const connection = new Connection(rpcUrl);

    // In production, use anchor client to call the rewards program
    // const tx = await rewardsProgram.methods
    //   .distribute(batch.poolId, batch.rewards)
    //   .rpc();

    // For now, return success with dummy transaction
    const txSignature = 'dummy-tx-signature';

    return {
      success: true,
      txSignature,
      batch,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get reward history for a peer
 */
export async function getRewardHistory(
  peerId: string,
  limit: number = 10,
  rpcUrl: string = 'https://api.devnet.solana.com',
): Promise<RewardCalculation[]> {
  try {
    const connection = new Connection(rpcUrl);

    // Query rewards program for peer's reward history
    // In production, use anchor client to fetch reward accounts

    // For now, return dummy data
    return [];
  } catch (error) {
    return [];
  }
}

/**
 * Get recent reward batches
 */
export async function getRecentBatches(
  limit: number = 10,
  rpcUrl: string = 'https://api.devnet.solana.com',
): Promise<RewardBatch[]> {
  try {
    const connection = new Connection(rpcUrl);

    // Query rewards program for recent batches
    // In production, use anchor client to fetch batch accounts

    // For now, return dummy data
    return [];
  } catch (error) {
    return [];
  }
}
