import { Module } from '@nestjs/common';
import { P2pHelper } from './helpers/p2p.js';
import { P2pService } from './p2p.service.js';

@Module({
  providers: [P2pHelper, P2pService],
  exports: [P2pService],
})
export class P2pModule {}
