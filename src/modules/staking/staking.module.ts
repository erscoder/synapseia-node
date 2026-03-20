import { Module } from '@nestjs/common';
import { StakingHelper } from './staking.js';
import { RewardsHelper } from './rewards.js';
import { StakingService } from './services/staking.service.js';
import { RewardsService } from './services/rewards.service.js';

@Module({
  providers: [StakingHelper, RewardsHelper, StakingService, RewardsService],
  exports: [StakingService, RewardsService],
})
export class StakingModule {}
