/**
 * `wallet-create` — keystore-only, non-interactive wallet bootstrap.
 *
 * The desktop UI (node-ui) spawns `syn wallet-create --name <node_name>`
 * during first-time setup and WAITS for the child to exit (see
 * `src-tauri/src/commands.rs::create_wallet`). `syn start` cannot replace
 * it — start is a long-running daemon that never exits. So this command
 * exists purely to "create a wallet then exit".
 *
 * SECURITY (F-node-008 max-security):
 *   - Writes ONLY the encrypted keystore (`~/.synapseia/wallet.keystore.json`
 *     via EncryptedKeystore, AES-256-GCM, scrypt KDF, mode 0600).
 *   - NEVER writes `wallet.json` (legacy plaintext-backed) nor
 *     `wallet-backup.json` (cleartext mnemonic). The mnemonic is printed
 *     ONCE to the terminal for the operator to record off-disk; it is
 *     never persisted to a file or a durable log.
 *   - env-var passphrase (SYNAPSEIA_WALLET_PASSWORD / WALLET_PASSWORD) is
 *     NEVER honoured. The passphrase arrives via stdin (UI:
 *     SYNAPSEIA_PASSPHRASE_FROM_STDIN=true) or a file-mounted secret
 *     (headless: SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE).
 *
 * NODE-UI CONTRACT (must match `create_wallet` exactly — do NOT change
 * node-ui):
 *   - Args:    `wallet-create --name <name>` plus optional `--model`,
 *              `--llm-url` (deprecated/ignored), `--llm-key`.
 *   - Stdout:  `__WALLET_OK__ <base58-pubkey>` on success — node-ui's
 *              `extract_pubkey` greps this exact sentinel and decodes the
 *              following token, asserting it is a 32-byte Solana pubkey.
 *   - Errors:  `WALLET_ALREADY_EXISTS` (exit 5), `PASSWORD_TOO_SHORT`
 *              (exit 2) — node-ui string-matches the combined stdout/stderr.
 *   - Min len: 8 chars. node-ui rejects `< 8` client-side as
 *              PASSWORD_TOO_SHORT, so this MUST stay 8 to honour the
 *              contract. (FOLLOW-UP: the keystore fresh-install path in
 *              `syn start` requires 12 chars; aligning the two would be a
 *              hardening win but would break node-ui's 8-char contract —
 *              defer until node-ui is bumped in lockstep.)
 *
 * This module is split out of `cli/index.ts` (the giant `bootstrap()`)
 * for two reasons: (1) the keystore-create logic is shared verbatim with
 * `syn start`'s fresh-install branch so the two cannot diverge, and (2)
 * the orchestration is unit-testable without booting NestJS/libp2p.
 */

import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { EncryptedKeystore } from '../infrastructure/keystore/EncryptedKeystore';

/** Minimal logger surface this module needs (matches `utils/logger`). */
export interface WalletCreateLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Subset of the node config this command mutates. */
export interface WalletCreateConfig {
  name?: string;
  defaultModel?: string;
  llmKey?: string;
  [key: string]: unknown;
}

/** Node config persistence port (NodeConfigService). */
export interface WalletCreateConfigStore {
  load(): WalletCreateConfig;
  save(config: WalletCreateConfig): void;
}

/** Identity persistence port (IdentityService). */
export interface WalletCreateIdentityStore {
  update(updates: { name?: string }, dir?: string): unknown;
}

/**
 * BIP39/BIP44/Solana keypair primitives. Injectable so the keystore-create
 * flow is unit-testable without loading the ESM-only crypto deps
 * (`@solana/web3.js`, `bip39`, `ed25519-hd-key`) that jest cannot transform.
 * Production defaults to the real dynamic imports.
 */
export interface KeypairCryptoProvider {
  generateMnemonic(): string;
  /** Derive a 32-byte ed25519 seed from a mnemonic via m/44'/501'/0'/0'. */
  deriveSeed32(mnemonic: string): Promise<Uint8Array>;
  /** Build a keypair from a 32-byte seed; returns base58 pubkey + 64-byte secret. */
  keypairFromSeed32(seed32: Uint8Array): { address: string; secretKey: Uint8Array };
}

/** Real crypto provider backed by the production ESM-only deps. */
export async function defaultKeypairCrypto(): Promise<KeypairCryptoProvider> {
  const solanaWeb3 = await import('@solana/web3.js');
  const bip39 = await import('bip39');
  const { derivePath } = await import('ed25519-hd-key');
  return {
    generateMnemonic: () => bip39.generateMnemonic(128),
    async deriveSeed32(mnemonic: string): Promise<Uint8Array> {
      const seed = await bip39.mnemonicToSeed(mnemonic);
      const { key } = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
      return new Uint8Array(key);
    },
    keypairFromSeed32(seed32: Uint8Array) {
      const kp = solanaWeb3.Keypair.fromSeed(seed32);
      return { address: kp.publicKey.toBase58(), secretKey: kp.secretKey };
    },
  };
}

export interface CreateKeypairDeps {
  keystore: Pick<EncryptedKeystore, 'encrypt' | 'getPath'>;
  logger: WalletCreateLogger;
  /** Crypto provider (defaults to the real ESM-only deps). */
  crypto?: KeypairCryptoProvider;
}

export interface CreateKeypairResult {
  address: string;
  mnemonic: string;
  secretKeyBytes: Uint8Array;
}

/**
 * Generate a fresh Solana keypair and encrypt it straight into the
 * hardened keystore. Prints the recovery mnemonic ONCE to the terminal
 * (never to disk). Returns the address + secret bytes for the caller's
 * downstream use (e.g. `syn start` reuses the bytes for activation).
 *
 * Shared by BOTH `syn start`'s fresh-install branch AND `wallet-create`
 * so the BIP39 → BIP44 (m/44'/501'/0'/0') → encrypt flow cannot diverge.
 */
export async function createKeypairIntoKeystore(
  passphrase: string,
  deps: CreateKeypairDeps,
): Promise<CreateKeypairResult> {
  const { keystore, logger } = deps;
  // Dynamic-import the heavy ESM-only crypto deps lazily so they stay out
  // of the fast-path bundle (chain-info / one-shot on-chain never load
  // them). Injectable for unit tests.
  const crypto = deps.crypto ?? (await defaultKeypairCrypto());

  // 12-word mnemonic (128 bits entropy). Derive via the standard BIP44
  // Solana path so the phrase imports cleanly into Phantom / Solflare /
  // Solana CLI. A direct Keypair.fromSeed on the raw seed would produce a
  // wallet unrecoverable from the mnemonic in any standard wallet.
  const mnemonic = crypto.generateMnemonic();
  const seed32 = await crypto.deriveSeed32(mnemonic);
  const { address, secretKey: secretKeyBytes } = crypto.keypairFromSeed32(seed32);

  await keystore.encrypt(secretKeyBytes, passphrase);
  logger.log(`[Keystore] new wallet encrypted at ${keystore.getPath()} (mode 0600)`);

  // Inline backup banner. The mnemonic is the operator's ONLY off-disk
  // recovery path; it is printed here and NEVER written to a file.
  logger.warn('');
  logger.warn('🔐  IMPORTANT — write down this recovery phrase NOW:');
  logger.warn(`     ${mnemonic}`);
  logger.warn('');
  logger.warn(`     Wallet address: ${address}`);
  logger.warn(`     Keystore file:  ${keystore.getPath()}`);
  logger.warn('     The mnemonic uses standard BIP44 Solana derivation (m/44/501/0/0)');
  logger.warn('     and can be imported into Phantom, Solflare, or any Solana wallet.');
  logger.warn('     The mnemonic is the ONLY way to recover this wallet if the keystore file is lost or corrupted. Store it offline (paper or hardware) and never share it.');
  logger.warn('');

  return { address, mnemonic, secretKeyBytes };
}

export interface RunWalletCreateOptions {
  name?: string;
  model?: string;
  llmUrl?: string;
  llmKey?: string;
}

export interface RunWalletCreateDeps {
  /** Resolved passphrase (already read from stdin / file by the caller). */
  passphrase: string | null | undefined;
  keystore: Pick<EncryptedKeystore, 'encrypt' | 'getPath' | 'exists'>;
  configStore: WalletCreateConfigStore;
  identityStore: WalletCreateIdentityStore;
  logger: WalletCreateLogger;
  /** Resolved node home (defaults to SYNAPSEIA_HOME / ~/.synapseia). */
  nodeHome?: string;
  /**
   * Path-existence probe (defaults to `fs.existsSync`). Injectable so the
   * legacy-wallet.json guard is unit-testable without mocking the `fs`
   * module (which the ESM transform freezes and which the dynamic
   * `@solana/web3.js` import also needs).
   */
  pathExists?: (p: string) => boolean;
  /** Crypto provider (defaults to the real ESM-only deps). */
  crypto?: KeypairCryptoProvider;
}

/**
 * Exit code the CLI handler should `process.exit()` with. Kept as a return
 * value (not a direct `process.exit`) so this orchestration is unit-testable.
 * Codes match the OLD wallet-create handler / node-ui's expectations:
 *   0 → success            (also prints `__WALLET_OK__ <pubkey>`)
 *   2 → PASSWORD_TOO_SHORT / missing passphrase
 *   4 → generic create error
 *   5 → WALLET_ALREADY_EXISTS
 */
export interface RunWalletCreateResult {
  exitCode: number;
  address?: string;
}

export async function runWalletCreate(
  options: RunWalletCreateOptions,
  deps: RunWalletCreateDeps,
): Promise<RunWalletCreateResult> {
  const { passphrase, keystore, configStore, identityStore, logger } = deps;
  const pathExists = deps.pathExists ?? existsSync;

  if (!passphrase) {
    logger.error(
      'SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE or SYNAPSEIA_PASSPHRASE_FROM_STDIN=true (with passphrase piped on stdin) is required for wallet-create',
    );
    return { exitCode: 2 };
  }
  // Min 8 — MUST match node-ui's client-side `password.len() < 8` check.
  if (passphrase.length < 8) {
    logger.error('PASSWORD_TOO_SHORT: password must be at least 8 characters');
    return { exitCode: 2 };
  }

  const nodeHome =
    deps.nodeHome ?? process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');

  // Refuse if EITHER a keystore OR a legacy wallet.json already exists.
  // Minting a second wallet would orphan funds tied to the first.
  const legacyWalletPath = path.join(nodeHome, 'wallet.json');
  if (keystore.exists() || pathExists(legacyWalletPath)) {
    logger.error('WALLET_ALREADY_EXISTS');
    return { exitCode: 5 };
  }

  try {
    const { address } = await createKeypairIntoKeystore(passphrase, {
      keystore,
      logger,
      crypto: deps.crypto,
    });

    // Persist base config atomically (no partial state). node-ui relies
    // on the node having a name/model afterwards.
    const cfg = configStore.load();
    if (options.name) cfg.name = options.name;
    if (options.model) cfg.defaultModel = options.model;
    if (options.llmUrl) {
      logger.warn('⚠️  --llm-url is deprecated and ignored (endpoints are hardcoded per provider)');
    }
    if (options.llmKey) cfg.llmKey = options.llmKey;
    configStore.save(cfg);

    // Keep identity.json in sync with the chosen name so heartbeat
    // broadcasts it.
    if (options.name) {
      identityStore.update({ name: options.name }, nodeHome);
    }

    // node-ui's `extract_pubkey` greps this exact sentinel.
    logger.log(`__WALLET_OK__ ${address}`);
    return { exitCode: 0, address };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`WALLET_CREATE_ERROR: ${msg}`);
    return { exitCode: 4 };
  }
}
