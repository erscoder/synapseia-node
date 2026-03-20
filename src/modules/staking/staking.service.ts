import { Injectable } from '@nestjs/common';
import {
  verifyStake,
  getMinimumStake,
  computeTier,
  meetsMinimumStake,
  getAllStakesForPeer,
  getTotalNetworkStake,
  type StakeInfo,
  type StakingVerificationResult,
} from '../../staking.js';

@Injectable()
export class StakingService {
  verify(peerId: string, rpcUrl?: string): Promise<StakingVerificationResult> {
    return verifyStake(peerId, rpcUrl);
  }

  getMinimumStake(tier: number): number {
    return getMinimumStake(tier);
  }

  computeTier(stakedAmount: number): number {
    return computeTier(stakedAmount);
  }

  meetsMinimum(stakedAmount: number, tier: number): boolean {
    return meetsMinimumStake(stakedAmount, tier);
  }

  getAllForPeer(peerId: string, rpcUrl?: string): Promise<StakeInfo[]> {
    return getAllStakesForPeer(peerId, rpcUrl);
  }

  getTotalNetworkStake(rpcUrl?: string): Promise<number> {
    return getTotalNetworkStake(rpcUrl);
  }
}
