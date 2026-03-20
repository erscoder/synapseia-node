import { Module } from '@nestjs/common';
import { HardwareService } from './hardware.service.js';

@Module({
  providers: [HardwareService],
  exports: [HardwareService],
})
export class HardwareModule {}
