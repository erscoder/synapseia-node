import { Module } from '@nestjs/common';
import { P2pHelper } from './p2p';
import { P2pService } from './services/p2p.service';

@Module({
  providers: [P2pHelper, P2pService],
  exports: [P2pService],
})
export class P2pModule {}
