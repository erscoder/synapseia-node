import { Injectable } from '@nestjs/common';
import { WalletHelper, type SolanaWallet, type WalletWithStatus } from '../../wallet.js';

@Injectable()
export class WalletService {
  constructor(private readonly walletHelper: WalletHelper) {}

  generate(walletDir?: string, password?: string): Promise<WalletWithStatus> {
    return this.walletHelper.generateWallet(walletDir, password);
  }

  load(walletDir?: string, password?: string): Promise<SolanaWallet> {
    return this.walletHelper.loadWallet(walletDir, password);
  }

  getOrCreate(walletDir?: string, password?: string): Promise<WalletWithStatus> {
    return this.walletHelper.getOrCreateWallet(walletDir, password);
  }

  getAddress(walletDir?: string): string {
    return this.walletHelper.getWalletAddress(walletDir);
  }

  has(walletDir?: string): boolean {
    return this.walletHelper.hasWallet(walletDir);
  }

  displayCreationWarning(wallet: SolanaWallet): void {
    return this.walletHelper.displayWalletCreationWarning(wallet);
  }

  changePassword(walletDir?: string): Promise<void> {
    return this.walletHelper.changeWalletPassword(walletDir);
  }

  promptForPassword(message?: string): Promise<string> {
    return this.walletHelper.promptForPassword(message);
  }

  promptForNewPassword(): Promise<string> {
    return this.walletHelper.promptForNewPassword();
  }
}
