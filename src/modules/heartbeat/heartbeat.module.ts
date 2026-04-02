import { Module } from '@nestjs/common';
import { HeartbeatHelper } from './heartbeat';
import { HeartbeatService } from './services/heartbeat.service';

@Module({
  providers: [HeartbeatHelper, HeartbeatService],
  exports: [HeartbeatService],
})
export class HeartbeatModule {}
