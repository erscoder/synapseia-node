import { Module } from '@nestjs/common';
import { HardwareHelper } from './hardware';
import { HardwareService } from './services/hardware.service';

@Module({
  providers: [HardwareHelper, HardwareService],
  exports: [HardwareService],
})
export class HardwareModule {}
