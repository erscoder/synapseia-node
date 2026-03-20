import { Module } from '@nestjs/common';
import { NodeConfigHelper } from './config.js';
import { NodeConfigService } from './services/node-config.service.js';

@Module({
  providers: [NodeConfigHelper, NodeConfigService],
  exports: [NodeConfigService],
})
export class NodeConfigModule {}
