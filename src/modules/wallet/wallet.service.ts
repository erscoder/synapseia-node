import { Injectable } from '@nestjs/common';
import {
  generateWallet,
  loadWallet,
  getOrCreateWallet,
  getWalletAddress,
  hasWallet,
  displayWalletCreationWarning,
  changeWalletPassword,
  promptForPassword,
  promptForNewPassword,
  type SolanaWallet,
  type WalletWithStatus,
} from '../../wallet.js';

@Injectable()
export class WalletService {
  generate(walletDir?: string, password?: string): Promise<WalletWithStatus> {
    return generateWallet(walletDir, password);
  }

  load(walletDir?: string, password?: string): Promise<SolanaWallet> {
    return loadWallet(walletDir, password);
  }

  getOrCreate(walletDir?: string, password?: string): Promise<WalletWithStatus> {
    return getOrCreateWallet(walletDir, password);
  }

  getAddress(walletDir?: string): string {
    return getWalletAddress(walletDir);
  }

  has(walletDir?: string): boolean {
    return hasWallet(walletDir);
  }

  displayCreationWarning(wallet: SolanaWallet): void {
    return displayWalletCreationWarning(wallet);
  }

  changePassword(walletDir?: string): Promise<void> {
    return changeWalletPassword(walletDir);
  }

  promptForPassword(message?: string): Promise<string> {
    return promptForPassword(message);
  }

  promptForNewPassword(): Promise<string> {
    return promptForNewPassword();
  }
}
