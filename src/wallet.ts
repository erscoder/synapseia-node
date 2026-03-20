/**
 * Solana wallet management for Synapse nodes
 * Generates and persists Solana keypairs with password-based encryption
 */

import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface SolanaWallet {
  publicKey: string;     // Base58 encoded Solana address
  secretKey: number[];   // Array of 64 bytes (32 private + 32 public)
  createdAt: string;     // ISO timestamp
  mnemonic?: string;     // BIP39 seed phrase (only in memory, never stored unencrypted)
}

export interface WalletWithStatus {
  wallet: SolanaWallet;
  isNew: boolean;        // True if wallet was just created
}

export interface EncryptedWallet {
  version: 1;
  publicKey: string;     // Public key (not encrypted, needed for display)
  encryptedData: string; // base64( salt + iv + authTag + ciphertext )
  salt: string;          // base64 salt for PBKDF2
  kdf: 'pbkdf2-sha256';
  kdfIterations: number;
  createdAt: string;
}

const WALLET_DIR = path.join(os.homedir(), '.synapse');
const WALLET_FILE = path.join(WALLET_DIR, 'wallet.json');
const BACKUP_FILE = path.join(WALLET_DIR, 'wallet-backup.json');

// Encryption constants
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive encryption key from password using PBKDF2
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt wallet data with password
 */
function encryptWallet(wallet: SolanaWallet, password: string): EncryptedWallet {
  // Generate random salt and IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key from password
  const key = deriveKey(password, salt);

  // Create cipher
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  // Encrypt the secret key
  const secretKeyBuffer = Buffer.from(wallet.secretKey);
  const encrypted = Buffer.concat([
    cipher.update(secretKeyBuffer),
    cipher.final()
  ]);

  // Get auth tag
  const authTag = cipher.getAuthTag();

  // Combine: salt + iv + authTag + encrypted
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);

  return {
    version: 1,
    publicKey: wallet.publicKey,
    encryptedData: combined.toString('base64'),
    salt: salt.toString('base64'),
    kdf: 'pbkdf2-sha256',
    kdfIterations: PBKDF2_ITERATIONS,
    createdAt: wallet.createdAt,
  };
}

/**
 * Decrypt wallet data with password
 */
function decryptWallet(encryptedWallet: EncryptedWallet, password: string): SolanaWallet {
  // Decode the combined data
  const combined = Buffer.from(encryptedWallet.encryptedData, 'base64');

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  // Derive key from password
  const key = deriveKey(password, salt);

  // Create decipher
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt
  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return {
      publicKey: encryptedWallet.publicKey,
      secretKey: Array.from(decrypted),
      createdAt: encryptedWallet.createdAt,
    };
  } catch (error) {
    throw new Error('Invalid password. Wallet decryption failed.');
  }
}

@Injectable()
export class WalletHelper {
  /**
   * Get password from environment or prompt
   * For Docker/non-interactive environments, use WALLET_PASSWORD env var
   */
  async promptForPassword(message: string = 'Enter wallet password: '): Promise<string> {
    // Check for env var first (useful for Docker)
    const envPassword = process.env.WALLET_PASSWORD;
    if (envPassword) {
      return envPassword;
    }

    const { password } = await import('@inquirer/prompts');
    return password({ message });
  }

  /**
   * Prompt for new password with confirmation
   * For Docker/non-interactive environments, use WALLET_PASSWORD env var
   */
  async promptForNewPassword(): Promise<string> {
    // Check for env var first (useful for Docker)
    const envPassword = process.env.WALLET_PASSWORD;
    if (envPassword) {
      if (envPassword.length < 8) {
        throw new Error('WALLET_PASSWORD must be at least 8 characters');
      }
      return envPassword;
    }

    const { password } = await import('@inquirer/prompts');

    const pass1 = await password({
      message: 'Create wallet password (min 8 characters):',
      validate: (input: string) => {
        if (input.length < 8) return 'Password must be at least 8 characters';
        return true;
      }
    });

    const pass2 = await password({
      message: 'Confirm wallet password:'
    });

    if (pass1 !== pass2) {
      throw new Error('Passwords do not match');
    }

    return pass1;
  }

  /**
   * Generate a new Solana wallet with mnemonic and encryption
   */
  async generateWallet(
    walletDir: string = WALLET_DIR,
    password?: string
  ): Promise<WalletWithStatus> {
    if (!existsSync(walletDir)) {
      mkdirSync(walletDir, { recursive: true, mode: 0o700 });
    }

    // Get password if not provided
    if (!password) {
      password = await this.promptForNewPassword();
    }

    try {
      // Dynamic imports
      const solanaWeb3 = await import('@solana/web3.js');
      const bip39 = await import('bip39');
      const { Keypair } = solanaWeb3;

      // Generate mnemonic (12 words = 128 bits entropy)
      const mnemonic = bip39.generateMnemonic(128);

      // Derive seed from mnemonic
      const seed = await bip39.mnemonicToSeed(mnemonic);

      // Use first 32 bytes of seed as private key
      const seedBytes = new Uint8Array(seed).slice(0, 32);

      // Generate keypair from seed
      const keypair = Keypair.fromSeed(seedBytes);

      const wallet: SolanaWallet = {
        publicKey: keypair.publicKey.toBase58(),
        secretKey: Array.from(keypair.secretKey),
        createdAt: new Date().toISOString(),
        mnemonic, // Include mnemonic for display
      };

      // Encrypt wallet
      const encryptedWallet = encryptWallet(wallet, password);

      // Save encrypted wallet.json
      writeFileSync(
        path.join(walletDir, 'wallet.json'),
        JSON.stringify(encryptedWallet, null, 2),
        { mode: 0o600 }
      );

      // Save backup file with mnemonic (also encrypted with same password)
      const backupData = {
        version: 1,
        publicKey: wallet.publicKey,
        mnemonic: mnemonic,
        encrypted: true,
        encryptedSecretKey: encryptedWallet.encryptedData,
        createdAt: wallet.createdAt,
        warning: "IMPORTANT: Store this mnemonic in a secure location. Anyone with access to these words can control your funds."
      };
      writeFileSync(
        BACKUP_FILE,
        JSON.stringify(backupData, null, 2),
        { mode: 0o600 }
      );

      // Return wallet with mnemonic for display (password not stored)
      return {
        wallet: { ...wallet },
        isNew: true
      };
    } catch (error) {
      throw new Error(
        `Failed to generate Solana wallet. Make sure @solana/web3.js and bip39 are installed. ${error}`
      );
    }
  }

  /**
   * Load existing Solana wallet (requires password)
   */
  async loadWallet(
    walletDir: string = WALLET_DIR,
    password?: string
  ): Promise<SolanaWallet> {
    const walletPath = path.join(walletDir, 'wallet.json');

    if (!existsSync(walletPath)) {
      throw new Error(`Wallet not found at ${walletPath}. Run generateWallet() first.`);
    }

    const content = readFileSync(walletPath, 'utf-8');
    const encryptedWallet = JSON.parse(content) as EncryptedWallet;

    if (!encryptedWallet.encryptedData) {
      throw new Error('Invalid wallet file structure');
    }

    // Get password if not provided
    if (!password) {
      password = await this.promptForPassword();
    }

    // Decrypt wallet
    return decryptWallet(encryptedWallet, password);
  }

  /**
   * Get or create wallet (convenience function for CLI)
   * Returns wallet and a flag indicating if it was newly created
   * Retries password prompt up to 3 times on invalid password
   */
  async getOrCreateWallet(
    walletDir: string = WALLET_DIR,
    password?: string
  ): Promise<WalletWithStatus> {
    const MAX_RETRIES = 3;
    let attempts = 0;

    while (attempts < MAX_RETRIES) {
      try {
        const wallet = await this.loadWallet(walletDir, password);
        return { wallet, isNew: false };
      } catch (error) {
        const errorMessage = (error as Error).message;

        // Wallet doesn't exist - create new one
        if (errorMessage.includes('Wallet not found')) {
          return this.generateWallet(walletDir, password);
        }

        // Invalid password - retry
        if (errorMessage.includes('Invalid password')) {
          attempts++;
          if (attempts < MAX_RETRIES) {
            console.log('\n❌ Invalid password. Please try again.');
            password = undefined; // Clear password to prompt again
            continue;
          }
          // Max retries reached
          console.log('\n❌ Invalid password after 3 attempts.');
          throw new Error('Maximum password attempts exceeded. Please check your password and try again.');
        }

        // Other errors - throw immediately
        throw error;
      }
    }

    throw new Error('Maximum password attempts exceeded.');
  }

  /**
   * Get wallet public key (address) for display
   * This can be read without password from encrypted file
   */
  getWalletAddress(walletDir: string = WALLET_DIR): string {
    try {
      const walletPath = path.join(walletDir, 'wallet.json');
      if (!existsSync(walletPath)) {
        return 'not configured';
      }
      const content = readFileSync(walletPath, 'utf-8');
      const encryptedWallet = JSON.parse(content) as EncryptedWallet;
      return encryptedWallet.publicKey;
    } catch {
      return 'not configured';
    }
  }

  /**
   * Check if wallet exists
   */
  hasWallet(walletDir: string = WALLET_DIR): boolean {
    const walletPath = path.join(walletDir, 'wallet.json');
    return existsSync(walletPath);
  }

  /**
   * Display wallet creation warning with seed phrase
   * This should be called when isNew is true
   */
  displayWalletCreationWarning(wallet: SolanaWallet): void {
    if (!wallet.mnemonic) return;

    console.log('\n' + '═'.repeat(70));
    console.log('  IMPORTANT: SAVE YOUR RECOVERY PHRASE');
    console.log('═'.repeat(70));
    console.log('\nYour Solana wallet has been created. Write down these 12 words\nand store them in a secure, offline location:');
    console.log('\n  ' + wallet.mnemonic);
    console.log('\nAnyone with access to these words can control your funds.');
    console.log('Never share your recovery phrase with anyone.');
    console.log('\nA backup has also been saved to:');
    console.log(`  ${BACKUP_FILE}`);
    console.log('═'.repeat(70) + '\n');
  }

  /**
   * Change wallet password
   */
  async changeWalletPassword(
    walletDir: string = WALLET_DIR
  ): Promise<void> {
    // Load with current password
    const oldPassword = await this.promptForPassword('Enter current password: ');
    const wallet = await this.loadWallet(walletDir, oldPassword);

    // Get new password
    const newPassword = await this.promptForNewPassword();

    // Re-encrypt with new password
    const encryptedWallet = encryptWallet(wallet, newPassword);

    writeFileSync(
      path.join(walletDir, 'wallet.json'),
      JSON.stringify(encryptedWallet, null, 2),
      { mode: 0o600 }
    );

    console.log('Password changed successfully');
  }
}

// Backward-compatible standalone function exports (used by src/index.ts CLI)
export const promptForPassword = (...args: Parameters<WalletHelper['promptForPassword']>) =>
  new WalletHelper().promptForPassword(...args);

export const promptForNewPassword = (...args: Parameters<WalletHelper['promptForNewPassword']>) =>
  new WalletHelper().promptForNewPassword(...args);

export const generateWallet = (...args: Parameters<WalletHelper['generateWallet']>) =>
  new WalletHelper().generateWallet(...args);

export const loadWallet = (...args: Parameters<WalletHelper['loadWallet']>) =>
  new WalletHelper().loadWallet(...args);

export const getOrCreateWallet = (...args: Parameters<WalletHelper['getOrCreateWallet']>) =>
  new WalletHelper().getOrCreateWallet(...args);

export const getWalletAddress = (...args: Parameters<WalletHelper['getWalletAddress']>) =>
  new WalletHelper().getWalletAddress(...args);

export const hasWallet = (...args: Parameters<WalletHelper['hasWallet']>) =>
  new WalletHelper().hasWallet(...args);

export const displayWalletCreationWarning = (...args: Parameters<WalletHelper['displayWalletCreationWarning']>) =>
  new WalletHelper().displayWalletCreationWarning(...args);

export const changeWalletPassword = (...args: Parameters<WalletHelper['changeWalletPassword']>) =>
  new WalletHelper().changeWalletPassword(...args);
