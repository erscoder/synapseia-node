import { Module } from '@nestjs/common';
import { StakingService } from './staking.service.js';
import { RewardsService } from './rewards.service.js';

@Module({
  providers: [StakingService, RewardsService],
  exports: [StakingService, RewardsService],
})
export class StakingModule {}
