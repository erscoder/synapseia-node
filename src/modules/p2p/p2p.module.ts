import { Module } from '@nestjs/common';
import { P2pService } from './p2p.service.js';

@Module({
  providers: [P2pService],
  exports: [P2pService],
})
export class P2pModule {}
