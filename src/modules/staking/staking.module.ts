import { Module } from '@nestjs/common';
import { StakingHelper } from './staking';
import { RewardsHelper } from './rewards';
import { StakingService } from './services/staking.service';
import { RewardsService } from './services/rewards.service';

@Module({
  providers: [StakingHelper, RewardsHelper, StakingService, RewardsService],
  exports: [StakingService, RewardsService],
})
export class StakingModule {}
