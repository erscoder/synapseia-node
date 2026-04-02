import { Module } from '@nestjs/common';
import { WalletHelper } from './wallet';
import { WalletService } from './services/wallet.service';

@Module({
  providers: [WalletHelper, WalletService],
  exports: [WalletService],
})
export class WalletModule {}
