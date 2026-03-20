import { Module } from '@nestjs/common';
import { HeartbeatHelper } from '../../heartbeat.js';
import { HeartbeatService } from './heartbeat.service.js';

@Module({
  providers: [HeartbeatHelper, HeartbeatService],
  exports: [HeartbeatService],
})
export class HeartbeatModule {}
