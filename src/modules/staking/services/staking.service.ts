import { Injectable } from '@nestjs/common';
import { StakingHelper, type StakeInfo, type StakingVerificationResult } from '../staking';

@Injectable()
export class StakingService {
  constructor(private readonly stakingHelper: StakingHelper) {}

  verify(peerId: string, rpcUrl?: string): Promise<StakingVerificationResult> {
    return this.stakingHelper.verifyStake(peerId, rpcUrl);
  }

  getMinimumStake(tier: number): number {
    return this.stakingHelper.getMinimumStake(tier);
  }

  computeTier(stakedAmount: number): number {
    return this.stakingHelper.computeTier(stakedAmount);
  }

  meetsMinimum(stakedAmount: number, tier: number): boolean {
    return this.stakingHelper.meetsMinimumStake(stakedAmount, tier);
  }

  getAllForPeer(peerId: string, rpcUrl?: string): Promise<StakeInfo[]> {
    return this.stakingHelper.getAllStakesForPeer(peerId, rpcUrl);
  }

  getTotalNetworkStake(rpcUrl?: string): Promise<number> {
    return this.stakingHelper.getTotalNetworkStake(rpcUrl);
  }
}
