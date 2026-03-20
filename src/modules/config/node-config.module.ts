import { Module } from '@nestjs/common';
import { NodeConfigService } from './node-config.service.js';

@Module({
  providers: [NodeConfigService],
  exports: [NodeConfigService],
})
export class NodeConfigModule {}
