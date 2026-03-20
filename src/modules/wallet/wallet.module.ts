import { Module } from '@nestjs/common';
import { WalletHelper } from './wallet.js';
import { WalletService } from './services/wallet.service.js';

@Module({
  providers: [WalletHelper, WalletService],
  exports: [WalletService],
})
export class WalletModule {}
