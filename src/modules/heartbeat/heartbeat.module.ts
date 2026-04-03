import { Module } from '@nestjs/common';
import { HeartbeatHelper } from './heartbeat';
import { HeartbeatService } from './services/heartbeat.service';
import { IpifyService } from '../shared/infrastructure/ipify.service';

@Module({
  providers: [IpifyService, HeartbeatHelper, HeartbeatService],
  exports: [HeartbeatService],
})
export class HeartbeatModule {}
