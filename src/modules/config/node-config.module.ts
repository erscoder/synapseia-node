import { Module } from '@nestjs/common';
import { NodeConfigHelper } from './config';
import { NodeConfigService } from './services/node-config.service';

@Module({
  providers: [NodeConfigHelper, NodeConfigService],
  exports: [NodeConfigService],
})
export class NodeConfigModule {}
