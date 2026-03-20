import { Module } from '@nestjs/common';
import { StakingHelper } from './helpers/staking.js';
import { RewardsHelper } from './helpers/rewards.js';
import { StakingService } from './staking.service.js';
import { RewardsService } from './rewards.service.js';

@Module({
  providers: [StakingHelper, RewardsHelper, StakingService, RewardsService],
  exports: [StakingService, RewardsService],
})
export class StakingModule {}
