/**
 * Solana wallet management for Synapseia nodes
 * Generates and persists Solana keypairs with password-based encryption
 */

import { Injectable } from '@nestjs/common';
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, fchmodSync, closeSync, renameSync, unlinkSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import logger from '../../utils/logger';

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
  /**
   * Keystore format version.
   *   - v1: PBKDF2 100_000 iterations (legacy, decrypt-only).
   *   - v2: PBKDF2 600_000 iterations (F-node-009, OWASP 2024+ baseline).
   * New keystores written by this module are ALWAYS v2. v1 is accepted on
   * read for back-compat so existing wallets keep decrypting; the field
   * `kdfIterations` is the authoritative iteration count (the version
   * is just a coarse generation tag).
   */
  version: 1 | 2;
  publicKey: string;     // Public key (not encrypted, needed for display)
  encryptedData: string; // base64( salt + iv + authTag + ciphertext )
  salt: string;          // base64 salt for PBKDF2
  kdf: 'pbkdf2-sha256';
  kdfIterations: number;
  createdAt: string;
}

// Evaluated lazily so SYNAPSEIA_HOME set before require() is honoured
const getWalletDir = () => process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
const WALLET_DIR = getWalletDir();
const WALLET_FILE = path.join(WALLET_DIR, 'wallet.json');

// Encryption constants.
//
// F-node-009 (MED): bumped PBKDF2 iter count 100_000 → 600_000 to match
// OWASP 2024+ baseline for PBKDF2-HMAC-SHA256. The legacy 100_000 value
// stays available as `PBKDF2_ITERATIONS_V1` so v1 keystores written by
// previous node releases continue to decrypt — readers detect the
// version + iter count from the keystore JSON and feed it back into
// `deriveKey`. New encrypts ALWAYS use V2.
export const PBKDF2_ITERATIONS_V1 = 100_000;
export const PBKDF2_ITERATIONS_V2 = 600_000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive encryption key from password using PBKDF2.
 *
 * `iterations` is REQUIRED — callers MUST pass the keystore's recorded
 * iter count when decrypting (back-compat with v1) or `PBKDF2_ITERATIONS_V2`
 * when encrypting fresh. We removed the default to make the back-compat
 * path explicit; a missing iter count is a programming error, not a
 * silent fallback to the old weak value.
 */
function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt wallet data with password
 */
function encryptWallet(wallet: SolanaWallet, password: string): EncryptedWallet {
  // Generate random salt and IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // F-node-009: new keystores always use v2 (600k PBKDF2 iterations).
  const iterations = PBKDF2_ITERATIONS_V2;
  // Derive key from password
  const key = deriveKey(password, salt, iterations);

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
    version: 2,
    publicKey: wallet.publicKey,
    encryptedData: combined.toString('base64'),
    salt: salt.toString('base64'),
    kdf: 'pbkdf2-sha256',
    kdfIterations: iterations,
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

  // F-node-009: honor the iter count stored in the keystore so v1
  // wallets (100k iterations) still decrypt under the v2 baseline
  // (600k). Fail-closed if the field is missing AND the version tag
  // doesn't tell us which generation to use — never silently fall back
  // to either constant.
  let iterations: number;
  if (typeof encryptedWallet.kdfIterations === 'number' && encryptedWallet.kdfIterations > 0) {
    iterations = encryptedWallet.kdfIterations;
  } else if (encryptedWallet.version === 1) {
    iterations = PBKDF2_ITERATIONS_V1;
  } else if (encryptedWallet.version === 2) {
    iterations = PBKDF2_ITERATIONS_V2;
  } else {
    throw new Error('Invalid wallet keystore: missing kdfIterations and unknown version');
  }
  // Derive key from password
  const key = deriveKey(password, salt, iterations);

  // Create decipher
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt
  let decrypted: Buffer | undefined;
  try {
    decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return {
      publicKey: encryptedWallet.publicKey,
      // Array.from copies the bytes; the source `decrypted` Buffer is wiped in
      // the finally block below.
      secretKey: Array.from(decrypted),
      createdAt: encryptedWallet.createdAt,
    };
  } catch (error) {
    throw new Error('Invalid password. Wallet decryption failed.');
  } finally {
    // Best-effort zeroization (audit L1160): overwrite the derived KDF key and
    // the plaintext secret-key Buffer once the bytes have been copied out. JS
    // zeroization is best-effort only — the returned `secretKey` array still
    // holds the key for the caller, and GC may already have copied these bytes;
    // this narrows, not closes, the in-memory window.
    key.fill(0);
    if (decrypted) decrypted.fill(0);
  }
}

/**
 * Atomically persist `wallet.json`.
 *
 * P18 (atomic file I/O): a partial/crashing write must NEVER leave a
 * truncated keystore in place of the good one. We write the full content
 * to a sibling `<file>.tmp` in the SAME directory (so `rename` is an
 * atomic, same-filesystem operation on POSIX), `fsync` the descriptor to
 * flush the bytes to disk before the rename, then `rename` over the
 * original. On any failure the tmp is unlinked and the original
 * `wallet.json` stays untouched + valid.
 */
function atomicWriteFileSync(targetPath: string, content: string, mode = 0o600): void {
  // L2: a unique per-write tmp name (pid + 6 random bytes) so two concurrent
  // writers never share a tmp file. The catch-path unlink then only ever
  // removes THIS caller's own tmp — never a sibling writer's in-progress one
  // (loadWallet now re-encrypts+persists on every unlock, so a node-ui bg
  // process and an operator `syn` command can both reach this concurrently).
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'w', mode);
    // L1: openSync's `mode` only applies when the file is CREATED. Enforce
    // 0o600 on the fd unconditionally so the final wallet.json (renamed from
    // this tmp) can never inherit loose perms — the tmp holds the only copy of
    // the encrypted secret key.
    fchmodSync(fd, mode);
    // writeSync may write fewer bytes than supplied without throwing, so loop
    // until the whole buffer is flushed — a short write here would otherwise
    // let fsync+rename atomically commit a TRUNCATED keystore over the good
    // one (the inverse of the P18 guarantee this helper provides).
    const buf = Buffer.from(content, 'utf-8');
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    // Flush the file contents to the storage device before we expose it via
    // rename — otherwise a crash between rename and flush could surface a
    // zero-length or partial file under the real name.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Atomic on POSIX: the original never observes a partial state.
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Clean up the descriptor + the partial tmp; the good original (if any)
    // is left intact because we never wrote over it.
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closing on failure */ }
    }
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// SECURITY (F-node-008 / P9): env-var passphrases are PERMANENTLY
// BLACKHOLED. Both `SYNAPSEIA_WALLET_PASSWORD` and the legacy
// `WALLET_PASSWORD` are unreadable to this module no matter what other
// flags are set: they were inheritable to any sibling at the same UID
// via `/proc/<pid>/environ` and to every python subprocess the node
// spawned, so the opt-in escape hatch (the historical
// `SYNAPSEIA_ALLOW_INSECURE_ENV_PASSPHRASE` flag) has been removed.
//
// Valid passphrase sources downstream of this helper:
//   1. `SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE` — mode 0600 file-mounted
//      secret (Docker secret / systemd LoadCredential / k8s mount),
//      resolved via `readPassphraseFromFile()` in passphrase-helpers.ts.
//   2. Interactive TTY prompt (`@inquirer/prompts` `password`).
//   3. Tauri IPC argument piped through child stdin (the desktop UI
//      writes the typed password to the spawned CLI's stdin in
//      non-interactive mode — never via env).
//
// This helper exists only to detect the FORBIDDEN env vars and emit a
// loud stderr warning so an operator who still exports them sees the
// misconfiguration immediately (the structured logger may be silent on
// CI / container stdout).
function warnIfEnvPassphraseSet(): void {
  const offending: string[] = [];
  if (typeof process.env.SYNAPSEIA_WALLET_PASSWORD === 'string'
      && process.env.SYNAPSEIA_WALLET_PASSWORD.length > 0) {
    offending.push('SYNAPSEIA_WALLET_PASSWORD');
  }
  if (typeof process.env.WALLET_PASSWORD === 'string'
      && process.env.WALLET_PASSWORD.length > 0) {
    offending.push('WALLET_PASSWORD');
  }
  if (offending.length === 0) return;
  process.stderr.write(
    `[Wallet] SECURITY: ignoring ${offending.join('/')} — env-var passphrase ` +
    'is NEVER honoured (F-node-008 max-security mode, no opt-in). Use ' +
    'SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE (mode 0600 file-mounted secret) ' +
    'or an interactive TTY prompt instead. Unset the env var to silence ' +
    'this warning.\n',
  );
}

@Injectable()
export class WalletHelper {
  /**
   * Get password from interactive prompt.
   *
   * SECURITY (F-node-008 / P9): env-var passphrase is PERMANENTLY
   * disabled. `SYNAPSEIA_WALLET_PASSWORD` / `WALLET_PASSWORD` are
   * never honoured — they were inheritable to any sibling at the same
   * UID via `/proc/<pid>/environ` and to every python subprocess. The
   * Tauri desktop UI now pipes the typed passphrase over child stdin
   * instead of env (see `SYNAPSEIA_PASSPHRASE_FROM_STDIN` in the CLI
   * boot path). Headless servers MUST use
   * `SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE`.
   */
  async promptForPassword(message: string = 'Enter wallet password: '): Promise<string> {
    warnIfEnvPassphraseSet();

    const { password } = await import('@inquirer/prompts');
    return password({ message });
  }

  /**
   * Prompt for new password with confirmation.
   *
   * SECURITY (F-node-008 / P9): same hardening as `promptForPassword` —
   * env-var passphrase is never accepted, no opt-in path remains.
   */
  async promptForNewPassword(): Promise<string> {
    warnIfEnvPassphraseSet();

    const { password } = await import('@inquirer/prompts');

    logger.log('[Wallet] welcome to Synapseia Network — keep your password safe, it cannot be recovered');

    // Retry loop until passwords match
    while (true) {
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

      if (pass1 === pass2) {
        return pass1;
      }

      logger.warn('[Wallet] passwords do not match — try again');
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
      throw new Error(`Wallet not found at ${walletPath}. Run 'syn start' to create an encrypted keystore wallet.`);
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
    const wallet = decryptWallet(encryptedWallet, password);

    // Workstream E: transparent weak-PBKDF2 upgrade on unlock. If the
    // keystore that just decrypted is a legacy v1 (or any keystore whose
    // recorded iteration count is below the v2 600k baseline), re-encrypt it
    // under the SAME password to v2 and atomically persist over wallet.json.
    // The authoritative signal is `kdfIterations` (the version tag is a
    // coarse generation marker; pre-versioned wallets may have only the
    // count). A missing/zero count means decrypt already resolved iterations
    // from `version === 1` (→ 100k) — treat that as below-baseline too.
    const recordedIterations =
      typeof encryptedWallet.kdfIterations === 'number' && encryptedWallet.kdfIterations > 0
        ? encryptedWallet.kdfIterations
        : (encryptedWallet.version === 2 ? PBKDF2_ITERATIONS_V2 : PBKDF2_ITERATIONS_V1);

    if (recordedIterations < PBKDF2_ITERATIONS_V2) {
      // BEST-EFFORT: an upgrade write must NEVER throw out of the unlock
      // path. The caller already holds their decrypted wallet; a failed
      // re-encrypt/persist is logged (no secrets) and swallowed.
      try {
        const upgraded = encryptWallet(wallet, password);
        atomicWriteFileSync(walletPath, JSON.stringify(upgraded, null, 2));
        // Non-secret fact only: iter counts + version, never key/password/mnemonic.
        logger.log(
          `[Wallet] upgraded keystore v1->v2 (PBKDF2 ${recordedIterations}->${PBKDF2_ITERATIONS_V2} iterations)`,
        );
      } catch (err) {
        // Log the error message only (it carries fs/path info, never secrets)
        // and continue with the already-loaded wallet.
        logger.warn(
          `[Wallet] keystore v1->v2 upgrade failed (continuing with unlocked wallet): ${(err as Error).message}`,
        );
      }
    }

    return wallet;
  }

  /**
   * Load an existing legacy wallet.json (convenience wrapper for the CLI
   * legacy-migration path). LOAD-ONLY: creation of new plaintext-backed
   * wallets was removed — a fresh wallet is only ever created via the
   * encrypted keystore on `syn start`. If no wallet.json exists this
   * throws, so an operator without a legacy wallet is routed to the
   * keystore fresh-install path instead of silently minting a new
   * cleartext-backed wallet here.
   * Retries password prompt up to 3 times on invalid password.
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

        // Wallet doesn't exist — creation is no longer supported here.
        // Surface the load error so the caller can route to the keystore
        // path. NEVER mint a new plaintext-backed wallet.
        if (errorMessage.includes('Wallet not found')) {
          throw error;
        }

        // Invalid password - retry
        if (errorMessage.includes('Invalid password')) {
          attempts++;
          if (attempts < MAX_RETRIES) {
            logger.warn('[Wallet] invalid password — try again');
            password = undefined; // Clear password to prompt again
            continue;
          }
          // Max retries reached
          logger.error('[Wallet] invalid password after 3 attempts');
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

    // SECURITY (F-node MEDIUM): the recovery mnemonic must NEVER pass
    // through the structured logger. `logger.*` forwards every arg to the
    // telemetry tap (see utils/logger.ts `callTap` → TelemetryClient), so
    // a `logger.log(mnemonic)` would ship the seed phrase off-box. The
    // loud warning banner carries no secret and is fine on the logger.
    logger.warn('[Wallet] IMPORTANT — save your recovery phrase offline. Anyone with these 12 words controls your funds:');

    // The mnemonic itself goes ONLY to a raw, interactive TTY — never to a
    // log transport. When stdout is piped/redirected/non-interactive (e.g.
    // the node-ui stdin-passphrase creation flow), we do NOT emit the seed
    // to any sink; we print a notice (also raw-TTY-gated) explaining the
    // mnemonic is shown only at interactive creation.
    if (process.stdout.isTTY) {
      // Raw write — bypasses the logger/telemetry tap entirely.
      process.stdout.write(`[Wallet] recovery phrase: ${wallet.mnemonic}\n`);
    } else {
      // Non-interactive: the mnemonic is intentionally withheld from every
      // sink. Surfacing the notice through stderr (raw, no tap) keeps it
      // off the structured logger as well.
      process.stderr.write(
        '[Wallet] recovery phrase available only at interactive (TTY) creation — re-create on a terminal to view it.\n'
      );
    }
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

    // P18: atomic write so a partial/crashing write can never corrupt or
    // lose the keystore (the only copy of the encrypted secret key).
    atomicWriteFileSync(
      path.join(walletDir, 'wallet.json'),
      JSON.stringify(encryptedWallet, null, 2),
    );

    logger.log('[Wallet] password changed successfully');
  }
}

// Backward-compatible standalone function exports (used by src/index.ts CLI)
export const promptForPassword = (...args: Parameters<WalletHelper['promptForPassword']>) =>
  new WalletHelper().promptForPassword(...args);

export const promptForNewPassword = (...args: Parameters<WalletHelper['promptForNewPassword']>) =>
  new WalletHelper().promptForNewPassword(...args);

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
