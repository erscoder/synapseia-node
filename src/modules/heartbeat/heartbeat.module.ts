import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HeartbeatHelper } from './heartbeat';
import { HeartbeatService } from './services/heartbeat.service';
import { IpifyService } from '../shared/infrastructure/ipify.service';

@Module({
  imports: [HttpModule],
  providers: [IpifyService, HeartbeatHelper, HeartbeatService],
  exports: [HeartbeatService],
})
export class HeartbeatModule {}
