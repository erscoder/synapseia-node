import { Module } from '@nestjs/common';
import { HardwareHelper } from '../../hardware.js';
import { HardwareService } from './hardware.service.js';

@Module({
  providers: [HardwareHelper, HardwareService],
  exports: [HardwareService],
})
export class HardwareModule {}
