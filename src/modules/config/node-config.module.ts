import { Module } from '@nestjs/common';
import { NodeConfigHelper } from './helpers/config.js';
import { NodeConfigService } from './node-config.service.js';

@Module({
  providers: [NodeConfigHelper, NodeConfigService],
  exports: [NodeConfigService],
})
export class NodeConfigModule {}
