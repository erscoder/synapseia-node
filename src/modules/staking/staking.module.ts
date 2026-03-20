import { Module } from '@nestjs/common';
import { StakingHelper } from '../../staking.js';
import { RewardsHelper } from '../../rewards.js';
import { StakingService } from './staking.service.js';
import { RewardsService } from './rewards.service.js';

@Module({
  providers: [StakingHelper, RewardsHelper, StakingService, RewardsService],
  exports: [StakingService, RewardsService],
})
export class StakingModule {}
