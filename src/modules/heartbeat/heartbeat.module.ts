import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service.js';

@Module({
  providers: [HeartbeatService],
  exports: [HeartbeatService],
})
export class HeartbeatModule {}
