/**
 * On-chain staking operations for CLI
 * Implements stake, unstake, claimRewards, deposit, and withdraw using raw Solana transactions
 */

import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';

// CU budget + priority fee for user-signed txs. 200k (default) is too low
// for Anchor stake/unstake/claim ixs that do a CPI SPL transfer. Over-
// requesting is free — only actually-consumed units are billed. Priority
// fee gets the tx included faster + keeps wallet simulators happy.
const DEFAULT_CU_LIMIT = 1_400_000;
const DEFAULT_CU_PRICE_MICROLAMPORTS = 10_000;
import logger from '../../utils/logger';
import { getAssociatedTokenAddress, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createTransferInstruction } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { input, password } from '@inquirer/prompts';
import { NodeConfigHelper, resolveSolanaRpcUrl } from '../config/config';
import { EncryptedKeystore, EncryptedKeystoreError } from '../../infrastructure/keystore/EncryptedKeystore';
import { readPassphraseFromFile, readPassphraseFromStdin } from '../../infrastructure/keystore/passphrase-helpers';
import { OFFICIAL_COORDINATOR_URL } from '../../constants/coordinator';
import {
  getStakingProgramId as resolveStakingProgramId,
  getSynTokenMint as resolveSynTokenMint,
} from '../../constants/programs';
import { computeLiveClaimableLamports } from './reward-estimate';

// Resolvers default to the official devnet program ids / mint; env vars
// (`STAKING_PROGRAM_ID`, `SYN_TOKEN_MINT`) override for dev clusters or a
// future mainnet flip. See `packages/node/src/constants/programs.ts`.
const getStakingProgramId = (): PublicKey => resolveStakingProgramId();
const getSynMint = (): PublicKey => resolveSynTokenMint();
// Solana RPC URL resolution: env var > persisted config.rpcUrl > devnet default.
// Synapseia runs on devnet today; operators that need a private RPC pin it via
// `syn config --set-rpc-url <url>` and it persists in ~/.synapseia/config.json.
// The CLI is invoked outside the Nest DI graph, so we instantiate the helper
// directly here instead of injecting it.
function getSolanaRpcUrl(): string {
  try {
    const helper = new NodeConfigHelper();
    return resolveSolanaRpcUrl(helper.loadConfig());
  } catch {
    // loadConfig should never throw (it returns defaults on parse failures),
    // but fall back to the resolver with a null config so the env-var-or-default
    // chain still works if anything unexpected goes wrong.
    return resolveSolanaRpcUrl(null);
  }
}
// Default to the official coordinator on a fresh pod / desktop install so
// `syn stake / unstake / claim` work without exporting COORDINATOR_URL.
// Pre-0.8.50 the fallback was `http://localhost:3701`, which only resolved
// for in-cluster coord developers — every other operator saw `fetch failed`
// on the coordinator-authority lookup in stakeTokens() and the tx never
// got built. Env var still wins so devs override locally.
// Bug 40 closed in 0.8.91 — all remaining inline `?? 'http://localhost:3701'`
// callers (a2a knowledge-query handler, active-model-subscriber, solana-balance
// helpers) were migrated to the getCoordinatorUrl() helper for consistency.
const COORDINATOR_URL = process.env.COORDINATOR_URL || OFFICIAL_COORDINATOR_URL;
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Lazy resolvers. Pre-S1.9 these were Proxy wrappers that returned
// raw property values, which broke `this`-binding inside PublicKey
// methods (`STAKING_PROGRAM_ID.toBase58()` ran with `this === proxy`,
// not the real PublicKey, producing corrupted bytes — audit P0 #8).
// We now resolve to a real `PublicKey` on first use and call the
// helper getters everywhere — `STAKING_PROGRAM_ID()` returns the same
// PublicKey instance every time.
let _STAKING_PROGRAM_ID: PublicKey | null = null;
let _SYN_MINT: PublicKey | null = null;
let _SOLANA_RPC_URL: string | null = null;
const STAKING_PROGRAM_ID = (): PublicKey =>
  (_STAKING_PROGRAM_ID ??= getStakingProgramId());
const SYN_MINT = (): PublicKey => (_SYN_MINT ??= getSynMint());
const SOLANA_RPC_URL_GETTER = () => (_SOLANA_RPC_URL ??= getSolanaRpcUrl());

// Derive vault authority PDA
function getVaultAuthorityPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake_vault_authority')],
    STAKING_PROGRAM_ID(),
  );
}

// Derive staking pool PDA — REQUIRED by stake/unstake/claim_rewards in
// the current syn_staking contract. Missing this account was the root
// cause of 'account not found' errors from the node CLI.
function getStakingPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('staking_pool')],
    STAKING_PROGRAM_ID(),
  );
}

// Derive the owner-keyed BanHistory PDA — REQUIRED by initialize_stake in
// the current syn_staking contract (seeds = [b"ban_history", owner], see
// target/idl/syn_staking.json). The contract `init`s this PDA on first
// stake so ban escalation survives a close+reopen cycle (F-contracts-010).
function getBanHistoryPDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ban_history'), owner.toBuffer()],
    STAKING_PROGRAM_ID(),
  );
}

/**
 * Returns true when a Solana error indicates the tx already landed on-chain.
 * Happens when the same signed tx is resubmitted within the ~60s blockhash
 * validity window (retry, double-enter, cached blockhash). Treated as
 * success by callers — chain state did accept the first submission.
 */
function isAlreadyProcessedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already been processed|already processed/i.test(msg);
}

/**
 * Build + send + confirm a transaction with an explicitly-fetched fresh
 * blockhash. Replaces the old pattern of `connection.sendTransaction(tx,
 * signers)` without confirm, which:
 *   - returned before the tx actually landed (races in scripted CLI)
 *   - reused cached blockhashes on retries, producing byte-identical
 *     signed txs and the "already been processed" error.
 *
 * If the first send comes back with "already processed", that means a
 * previous attempt DID land on-chain — we return the stale signature
 * so the CLI prints a useful diagnostic and the caller proceeds.
 */
export async function sendAndConfirmFresh(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  const payer = signers[0];
  if (!payer) throw new Error('sendAndConfirmFresh: at least one signer required');

  // Prepend ComputeBudget limit + priority fee so wallet simulators and
  // validators treat the tx as production-ready. Idempotent.
  const hasCuIx = tx.instructions.some(
    (ix) => ix.programId.equals(ComputeBudgetProgram.programId),
  );
  if (!hasCuIx) {
    // Price first, then limit.
    tx.instructions = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_CU_PRICE_MICROLAMPORTS }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_LIMIT }),
      ...tx.instructions,
    ];
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(...signers);
  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  } catch (err) {
    if (isAlreadyProcessedError(err)) {
      logger.warn('[staking-cli] tx flagged "already been processed" — first submission already landed, returning existing signature');
      // Recover the original signature from the signed tx (byte 1-65 of the signatures block).
      const s = tx.signatures[0]?.signature;
      return s ? s.toString('base64') : '';
    }
    throw err;
  }
}

// Get stake vault ATA
async function getStakeVaultATA(connection: Connection): Promise<PublicKey> {
  const [vaultAuthority] = getVaultAuthorityPDA();
  return getAssociatedTokenAddress(SYN_MINT(), vaultAuthority, true);
}

// Get treasury authority PDA
function getTreasuryAuthorityPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury_authority')],
    STAKING_PROGRAM_ID(),
  );
}

// Get treasury token account
async function getTreasuryTokenAccount(connection: Connection): Promise<PublicKey> {
  const [treasuryAuthority] = getTreasuryAuthorityPDA();
  return getAssociatedTokenAddress(SYN_MINT(), treasuryAuthority, true);
}

// Wallet encryption constants
const WALLET_DIR = () => process.env.SYNAPSEIA_HOME || path.join(os.homedir(), '.synapseia');
const WALLET_FILE = () => path.join(WALLET_DIR(), 'wallet.json');
// F-node-009 (MED): bumped 100k → 600k OWASP-2024 baseline. Legacy
// constant kept under V1 name for back-compat decrypt of v1 keystores.
const PBKDF2_ITERATIONS_V1 = 100_000;
const PBKDF2_ITERATIONS_V2 = 600_000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

// Derive encryption key from password.
// `iterations` is REQUIRED — caller passes the keystore's recorded iter
// count (legacy wallet.json may be v1 100k or v2 600k).
function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, 'sha256');
}

// Decrypt wallet. `walletData` is the raw JSON parsed from wallet.json;
// we look at its `kdfIterations` / `version` fields to pick the iter count
// rather than assuming 100k (which broke v2 wallets written by the new
// wallet.ts encryptor).
function decryptWallet(walletData: { encryptedData: string; kdfIterations?: number; version?: number }, password: string): Uint8Array {
  const combined = Buffer.from(walletData.encryptedData, 'base64');
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  let iterations: number;
  if (typeof walletData.kdfIterations === 'number' && walletData.kdfIterations > 0) {
    iterations = walletData.kdfIterations;
  } else if (walletData.version === 1) {
    iterations = PBKDF2_ITERATIONS_V1;
  } else if (walletData.version === 2) {
    iterations = PBKDF2_ITERATIONS_V2;
  } else {
    // Pre-versioned legacy wallets (no `version`/`kdfIterations` field).
    // Default to V1 — that's what this file historically wrote — so the
    // operator still gets a chance to decrypt + re-encrypt under the
    // hardened keystore via `syn start`.
    iterations = PBKDF2_ITERATIONS_V1;
  }

  // SECURITY (audit L1196): warn LOUDLY whenever a wallet is decrypted under a
  // pre-OWASP-2024 KDF iteration count (<600k). A version-less legacy wallet
  // silently falling back to 100k iterations was the finding's exposure: the
  // operator had no signal that their key is protected by a weak KDF. The
  // hardened migration path is `syn start`, which re-encrypts into the
  // EncryptedKeystore (scrypt). Transparent in-place re-encrypt of the legacy
  // wallet.json under the v2 600k path is NOT done here — this file has no
  // encryptor and an in-place atomic rewrite of the only wallet copy is a
  // corruption risk that needs its own scoped change.
  if (iterations < PBKDF2_ITERATIONS_V2) {
    process.stderr.write(
      `[staking-cli] SECURITY WARNING: wallet decrypted under a WEAK KDF ` +
      `(${iterations} PBKDF2 iterations < ${PBKDF2_ITERATIONS_V2} OWASP-2024 baseline). ` +
      `Migrate to the hardened keystore via 'syn start' to re-encrypt under stronger parameters.\n`,
    );
  }

  const key = deriveKey(password, salt, iterations);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  // Copy into the returned Uint8Array, then best-effort wipe the derived KDF
  // key and the plaintext source Buffer (audit L1160). JS zeroization is
  // best-effort only — the returned array still holds the key for the caller.
  const out = new Uint8Array(decrypted);
  key.fill(0);
  decrypted.fill(0);
  return out;
}

// Load and decrypt the wallet. Tries the hardened EncryptedKeystore
// first (the path `node start` writes to as of 0.6.x). Falls back to
// the legacy plaintext-encrypted `wallet.json` for operators that
// have not run a keystore-aware boot yet.
//
// Passphrase resolution (high → low priority):
//   1. `SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE` — mode 0600 file-mounted
//      secret (Docker / systemd / fly-machines).
//   2. `SYNAPSEIA_PASSPHRASE_FROM_STDIN=true` — first line of stdin
//      (Tauri desktop UI pipes the typed password here).
//   3. Interactive TTY prompt — `password({ message })`.
//
// SECURITY (F-node-008 / P9): `SYNAPSEIA_WALLET_PASSWORD` and the
// legacy `WALLET_PASSWORD` are NEVER honoured (no opt-in path remains).
// Both were inheritable to any sibling at the same UID via
// `/proc/<pid>/environ` and to every python subprocess the node
// spawned, so they're black-holed here. Detection of either triggers
// a loud stderr warning to surface the misconfiguration.
export async function loadWalletWithPassword(): Promise<Keypair> {
  // Resolve the keystore from SYNAPSEIA_HOME so the staking commands honour
  // the same data-dir override as the rest of the CLI (e.g. `wallet-verify`,
  // which builds `path.join(nodeHome, 'wallet.keystore.json')`). Without this
  // the hardened branch always read `~/.synapseia/wallet.keystore.json`,
  // ignoring SYNAPSEIA_HOME — so pointing the node at a backup wallet folder
  // only worked for the legacy `wallet.json` path. Defaults to `~/.synapseia`
  // when SYNAPSEIA_HOME is unset, preserving prior behaviour.
  const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
  const keystore = new EncryptedKeystore(path.join(nodeHome, 'wallet.keystore.json'));
  // Stderr warning if a forbidden env var is still set — we never read
  // it, but the operator should know it's a no-op and unset it.
  if (process.env.SYNAPSEIA_WALLET_PASSWORD || process.env.WALLET_PASSWORD) {
    const offending: string[] = [];
    if (process.env.SYNAPSEIA_WALLET_PASSWORD) offending.push('SYNAPSEIA_WALLET_PASSWORD');
    if (process.env.WALLET_PASSWORD) offending.push('WALLET_PASSWORD');
    process.stderr.write(
      `[staking-cli] SECURITY: ignoring ${offending.join('/')} — env-var passphrase ` +
      'is NEVER honoured (F-node-008 max-security mode, no opt-in). Use ' +
      'SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE or interactive TTY prompt instead.\n',
    );
  }

  if (keystore.exists()) {
    // Hardened branch. File-mounted secret wins; stdin pipe next
    // (Tauri-spawn channel); interactive prompt last.
    const filePass = await readPassphraseFromFile(
      process.env.SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE,
      logger,
    );
    const stdinPass = filePass ? undefined : await readPassphraseFromStdin(logger);
    let initialPass: string | null = filePass ?? stdinPass ?? null;
    let attempts = 0;
    const maxAttempts = 3;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pass = initialPass ?? await password({
        message: `Unlock wallet keystore (${keystore.getPath()}):`,
        mask: '*',
      });
      // Only the first iteration may use the non-interactive value; if
      // it fails the loop falls through to interactive retries.
      initialPass = null;
      try {
        const secretKey = await keystore.decrypt(pass);
        return Keypair.fromSecretKey(secretKey);
      } catch (err) {
        if (err instanceof EncryptedKeystoreError && err.code === 'INVALID_PASSPHRASE') {
          attempts++;
          if (attempts >= maxAttempts) {
            throw new Error('Invalid keystore passphrase after 3 attempts');
          }
          logger.warn('[Keystore] invalid passphrase, try again');
          continue;
        }
        throw new Error(`Failed to unlock keystore: ${(err as Error).message}`);
      }
    }
  }

  // Legacy fallback — same behaviour as before the keystore migration.
  // Operators that have not run `syn start` on a keystore-aware version
  // still hit this path. Env-var passphrases are NOT accepted here
  // either; the resolution chain is file → stdin → prompt.
  const walletFile = WALLET_FILE();
  if (!fs.existsSync(walletFile)) {
    throw new Error(
      `No wallet found. Expected ${keystore.getPath()} or ${walletFile}. Run 'syn start' to bootstrap a wallet.`,
    );
  }
  logger.warn(
    '[staking-cli] using legacy wallet.json — migrate to the hardened keystore via `syn start` to reduce attack surface',
  );
  const walletData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  if (!walletData.encryptedData) {
    // SECURITY (F-node-001): plaintext `secretKey` wallet.json is REFUSED
    // outright. An attacker dropping a crafted wallet.json with a raw
    // 64-byte secretKey and NO encryptedData would otherwise be loaded
    // here as a signer for stake/unstake/claim — silent key substitution.
    // Backups must never round-trip via plaintext; require an explicit
    // operator override gated by SYNAPSEIA_ALLOW_LEGACY_WALLET=true for
    // dev/testing only.
    logger.error('[staking-cli] REFUSED: legacy plaintext wallet.json detected.');
    logger.error('Plaintext wallets are no longer supported (security regression).');
    logger.error('Migration: run `syn start` to bootstrap an encrypted keystore,');
    logger.error('or `syn wallet import` to re-import an existing key behind a passphrase.');
    logger.error('To override (testing only): set SYNAPSEIA_ALLOW_LEGACY_WALLET=true');
    if (process.env.SYNAPSEIA_ALLOW_LEGACY_WALLET !== 'true') {
      throw new Error(
        'Legacy plaintext wallet.json refused. Migrate to the hardened keystore or set SYNAPSEIA_ALLOW_LEGACY_WALLET=true to override.',
      );
    }
    logger.warn(
      '[staking-cli] WARNING: legacy plaintext wallet loaded via SYNAPSEIA_ALLOW_LEGACY_WALLET override — DO NOT use this in production.',
    );
    const secretKey = new Uint8Array(walletData.secretKey);
    return Keypair.fromSecretKey(secretKey);
  }
  // Legacy wallet.json passphrase resolution mirrors the hardened
  // keystore branch: file-mounted secret → stdin pipe → interactive
  // prompt. Env-var passphrase is permanently disabled.
  const legacyFilePass = await readPassphraseFromFile(
    process.env.SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE,
    logger,
  );
  const legacyStdinPass = legacyFilePass ? undefined : await readPassphraseFromStdin(logger);
  const walletPassword = legacyFilePass
    ?? legacyStdinPass
    ?? (await password({ message: 'Enter legacy wallet password:', mask: '*' }));
  try {
    const secretKey = decryptWallet(walletData, walletPassword);
    return Keypair.fromSecretKey(secretKey);
  } catch (e) {
    throw new Error('Invalid password or corrupted wallet file');
  }
}

// Get user's SYN token account
async function getUserTokenAccount(connection: Connection, wallet: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(SYN_MINT(), wallet);
}

// Create instruction data for stake
function createStakeInstructionData(amount: number): Buffer {
  const discriminator = Buffer.from([206, 176, 202, 18, 200, 209, 179, 108]);
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(BigInt(Math.floor(amount * 1_000_000_000)));
  return Buffer.concat([discriminator, amountBuffer]);
}

// Create instruction data for unstake
function createUnstakeInstructionData(amount: number): Buffer {
  const discriminator = Buffer.from([90, 95, 107, 42, 205, 124, 50, 225]);
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(BigInt(Math.floor(amount * 1_000_000_000)));
  return Buffer.concat([discriminator, amountBuffer]);
}

// Create instruction data for initializeStake
function createInitializeStakeInstructionData(tier: number): Buffer {
  const discriminator = Buffer.from([33, 175, 216, 4, 116, 130, 164, 177]);
  const tierBuffer = Buffer.alloc(1);
  tierBuffer.writeUInt8(tier);
  return Buffer.concat([discriminator, tierBuffer]);
}

// Create instruction data for claimRewards
function createClaimRewardsInstructionData(): Buffer {
  return Buffer.from([4, 144, 132, 71, 116, 23, 151, 80]);
}

// Stake SYN tokens
export async function stakeTokens(amount: number): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  // Get or create stake account
  const stakeAccountAddress = await findStakeAccount(connection, wallet.publicKey);
  
  let stakeAccount: Keypair;
  let stakeAccountPubkey: PublicKey;
  
  if (!stakeAccountAddress) {
    logger.log(`📝 Creating new stake account...`);
    stakeAccount = Keypair.generate();
    stakeAccountPubkey = stakeAccount.publicKey;

    // Fetch coordinator authority pubkey to register on the stake account.
    // coordinator_authority is stored (not a signer) — only the user signs here.
    const coordInfoRes = await fetch(`${COORDINATOR_URL}/stake/info/coordinator-authority`);
    if (!coordInfoRes.ok) throw new Error(`Failed to get coordinator authority: ${coordInfoRes.status}`);
    const { coordinatorAuthority } = await coordInfoRes.json() as { coordinatorAuthority: string };

    // InitializeStake context (target/idl/syn_staking.json — 6 accounts):
    //   0. stake_account        (signer, writable)
    //   1. owner                (signer, writable)
    //   2. coordinator_authority(read-only, stored not signed)
    //   3. staking_pool         (PDA [b"staking_pool"]) — read by the handler
    //      to seed coordinator_authority + accrual state. Added with the V3
    //      contract upgrade; omitting it now reverts with NotEnoughAccountKeys.
    //   4. ban_history          (PDA [b"ban_history", owner], writable) — the
    //      handler `init`s it so ban escalation survives close+reopen.
    //   5. system_program
    const [stakingPoolForInit] = getStakingPoolPDA();
    const [banHistory] = getBanHistoryPDA(wallet.publicKey);
    const initIx = new TransactionInstruction({
      programId: STAKING_PROGRAM_ID(),
      data: createInitializeStakeInstructionData(1), // tier 1 = minimum valid (contract requires 1-5)
      keys: [
        { pubkey: stakeAccount.publicKey, isSigner: true, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(coordinatorAuthority), isSigner: false, isWritable: false },
        { pubkey: stakingPoolForInit, isSigner: false, isWritable: false },
        { pubkey: banHistory, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ]
    });

    const initTx = new Transaction().add(initIx);
    const initSig = await sendAndConfirmFresh(connection, initTx, [wallet, stakeAccount]);
    logger.log(`   Stake account created: ${initSig}`);
  } else {
    stakeAccountPubkey = new PublicKey(stakeAccountAddress);
  }

  // Get token accounts + PDAs
  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  const stakeVault = await getStakeVaultATA(connection);
  const [vaultAuthority] = getVaultAuthorityPDA();
  const [stakingPool] = getStakingPoolPDA();

  logger.log(`\n📤 Staking ${amount} SYN tokens...`);

  // Make sure the user SYN ATA exists. Faucet flows that drop SYN onto a
  // wallet don't always init the ATA first (depends on which transfer
  // primitive the sender uses), so a first-time staker can hit
  // AnchorError 3012 "AccountNotInitialized" on `user_token_account`.
  // Prepend the createATA ix when missing — idempotent in practice.
  const preIxs: TransactionInstruction[] = [];
  const userAtaInfo = await connection.getAccountInfo(userTokenAccount);
  if (!userAtaInfo) {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    preIxs.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        userTokenAccount,
        wallet.publicKey,
        SYN_MINT(),
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    logger.log(`   User SYN ATA missing — creating it in the same tx`);
  }

  // StakeAction context needs: stake_account, owner, user_token_account,
  // stake_vault, syn_mint, vault_authority, token_program, staking_pool.
  // The staking_pool PDA is REQUIRED (contract reads daily_pool_lamports +
  // total_staked to accrue rewards). Missing it was the CLI regression.
  const stakeIx = new TransactionInstruction({
    programId: STAKING_PROGRAM_ID(),
    data: createStakeInstructionData(amount),
    keys: [
      { pubkey: stakeAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: stakeVault, isSigner: false, isWritable: true },
      { pubkey: SYN_MINT(), isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: stakingPool, isSigner: false, isWritable: true },
    ]
  });

  const stakeTx = new Transaction().add(...preIxs, stakeIx);
  const tx = await sendAndConfirmFresh(connection, stakeTx, [wallet]);

  logger.log(`✅ Stake successful!`);
  logger.log(`   Transaction: ${tx}`);

  return tx;
}

// Unstake SYN tokens
export async function unstakeTokens(amount: number): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  // Find stake account
  const stakeAccountAddress = await findStakeAccount(connection, wallet.publicKey);
  
  if (!stakeAccountAddress) {
    throw new Error('No stake account found. Have you staked any tokens?');
  }
  
  const stakeAccount = new PublicKey(stakeAccountAddress);

  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  const stakeVault = await getStakeVaultATA(connection);
  const [vaultAuthority] = getVaultAuthorityPDA();
  const [stakingPool] = getStakingPoolPDA();

  logger.log(`\n📥 Unstaking ${amount} SYN tokens...`);

  const unstakeIx = new TransactionInstruction({
    programId: STAKING_PROGRAM_ID(),
    data: createUnstakeInstructionData(amount),
    keys: [
      { pubkey: stakeAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: stakeVault, isSigner: false, isWritable: true },
      { pubkey: SYN_MINT(), isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: stakingPool, isSigner: false, isWritable: true },
    ]
  });

  const unstakeTx = new Transaction().add(unstakeIx);
  const tx = await sendAndConfirmFresh(connection, unstakeTx, [wallet]);

  logger.log(`✅ Unstake successful!`);
  logger.log(`   Transaction: ${tx}`);

  return tx;
}

// Claim rewards
export async function claimStakingRewards(): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  // Find stake account
  const stakeAccountAddress = await findStakeAccount(connection, wallet.publicKey);
  
  if (!stakeAccountAddress) {
    throw new Error('No stake account found. Have you staked any tokens?');
  }
  
  // Fetch stake account to check pending rewards
  const accountInfo = await connection.getAccountInfo(new PublicKey(stakeAccountAddress));
  if (!accountInfo) {
    throw new Error('Stake account not found on chain');
  }
  
  // Compute the LIVE claimable amount, NOT the raw on-chain `rewards_pending`
  // field. The raw field is only advanced by the coordinator's hourly accrue
  // cron, which lags real time (~13h observed) and reads 0 even when the
  // wallet has thousands of SYN claimable. node-ui's display already shows the
  // LIVE value (since v0.8.110); gating the claim on the raw field instead made
  // the Claim button do nothing. The on-chain `claim_rewards` ix self-accrues
  // `now - last_accrual_at` before sweeping (syn_staking lib.rs:535), so the
  // live estimate equals what a claim actually pays — we use it as the gate.
  const [stakingPool] = getStakingPoolPDA();
  const { lamports: liveRewardsLamports, estimateOk } = await computeLiveClaimableLamports(
    connection,
    accountInfo.data,
    stakingPool,
  );
  const rewards = Number(liveRewardsLamports) / 1_000_000_000;

  // 3-way gate (P10: comment reflects exactly what the code below does):
  //   live > 0                  → proceed (the live estimate shows claimable).
  //   live == 0 && estimateOk    → GENUINE zero; the live math ran and the
  //                                wallet truly has nothing. Early-return.
  //   live == 0 && !estimateOk   → UNKNOWN zero; the staking_pool read/estimate
  //                                FAILED and the raw fallback field is also 0.
  //                                We CANNOT prove there's nothing claimable, and
  //                                the wallet may hold live-but-unaccrued rewards
  //                                only the on-chain ix can see. PROCEED and let
  //                                `claim_rewards` accrue+verify; it fails closed
  //                                harmlessly (require!(rewards_to_claim > 0,
  //                                NoRewardsToClaim), syn_staking lib.rs:544) — a
  //                                genuine zero only costs a reverted-tx fee.
  if (rewards <= 0) {
    if (estimateOk) {
      logger.log(`ℹ️ No pending rewards to claim.`);
      return '';
    }
    logger.warn(
      '[staking-cli] live reward estimate unavailable (staking_pool read failed); ' +
        'attempting claim anyway — the on-chain ix will accrue/verify and revert ' +
        'harmlessly if there is nothing to claim.',
    );
  } else {
    logger.log(`\n💰 Claiming ~${rewards} SYN in rewards (live estimate)...`);
  }

  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  const [treasuryAuthority] = getTreasuryAuthorityPDA();
  const treasuryTokenAccount = await getTreasuryTokenAccount(connection);

  // Make sure the treasury ATA exists. If the wallet is the first to claim
  // rewards in the lifetime of this deploy, the PDA-owned ATA may not be
  // initialized yet. Prepend the createATA ix in that case.
  const preIxs: TransactionInstruction[] = [];
  const treasuryAtaInfo = await connection.getAccountInfo(treasuryTokenAccount);
  if (!treasuryAtaInfo) {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    preIxs.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        treasuryTokenAccount,
        treasuryAuthority,
        SYN_MINT(),
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    logger.log(`   Treasury ATA missing — will create it in the same tx`);
  }

  const claimIx = new TransactionInstruction({
    programId: STAKING_PROGRAM_ID(),
    data: createClaimRewardsInstructionData(),
    keys: [
      { pubkey: new PublicKey(stakeAccountAddress), isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: treasuryAuthority, isSigner: false, isWritable: false },
      { pubkey: SYN_MINT(), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: stakingPool, isSigner: false, isWritable: false },
    ]
  });

  const claimTx = new Transaction().add(...preIxs, claimIx);
  const tx = await sendAndConfirmFresh(connection, claimTx, [wallet]);

  logger.log(`✅ Rewards claimed!`);
  logger.log(`   Transaction: ${tx}`);

  return tx;
}

// Deposit SOL (airdrop for devnet)
export async function depositSol(amount: number): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  // Request airdrop on devnet
  const airdropAmount = Math.floor(amount * 1_000_000_000);
  logger.log(`\n💸 Requesting ${amount} SOL airdrop...`);
  
  try {
    const airdropSig = await connection.requestAirdrop(wallet.publicKey, airdropAmount);
    await connection.confirmTransaction(airdropSig);
    
    logger.log(`✅ Airdrop successful!`);
    logger.log(`   Transaction: ${airdropSig}`);
    return airdropSig;
  } catch (e) {
    // If airdrop not available, show address for manual transfer
    logger.log(`⚠️ Airdrop not available on this network`);
    logger.log(`   Send SOL to: ${wallet.publicKey.toBase58()}`);
    throw e;
  }
}

// Deposit SYN (transfer from another wallet)
export async function depositSyn(amount: number): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  
  logger.log(`\n📥 To deposit SYN, send tokens to your token account:`);
  logger.log(`   Address: ${userTokenAccount.toBase58()}`);
  logger.log(`   (This is your ATA - Associated Token Account for SYN)`);
  
  // Check balance
  const balance = await connection.getTokenAccountBalance(userTokenAccount).catch(() => null);
  if (balance) {
    logger.log(`   Current balance: ${Number(balance.value.uiAmountString)} SYN`);
  }
  
  return '';
}

// Withdraw SOL
export async function withdrawSol(amount: number, destinationAddress: string): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  const destination = new PublicKey(destinationAddress);
  const amountLamports = Math.floor(amount * 1_000_000_000);
  
  // Account for rent exemption (keep ~0.01 SOL)
  const minBalance = await connection.getMinimumBalanceForRentExemption(0);
  const balance = await connection.getBalance(wallet.publicKey);
  
  if (balance - amountLamports < minBalance) {
    throw new Error(`Cannot withdraw ${amount} SOL. Need to keep ~0.01 SOL for rent.`);
  }
  
  logger.log(`\n📤 Withdrawing ${amount} SOL to ${destinationAddress}...`);
  
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: destination,
      lamports: amountLamports
    })
  );

  const signature = await sendAndConfirmFresh(connection, tx, [wallet]);

  logger.log(`✅ Withdraw successful!`);
  logger.log(`   Transaction: ${signature}`);

  return signature;
}

// Withdraw SYN
export async function withdrawSyn(amount: number, destinationAddress: string): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  const destination = new PublicKey(destinationAddress);
  
  // Get source ATA
  const sourceTokenAccount = await getAssociatedTokenAddress(SYN_MINT(), wallet.publicKey);
  
  // Get or create destination ATA
  let destTokenAccount: PublicKey;
  try {
    destTokenAccount = await getAssociatedTokenAddress(SYN_MINT(), destination);
    
    // Check if destination ATA exists
    const destAccountInfo = await connection.getAccountInfo(destTokenAccount);
    if (!destAccountInfo) {
      // Need to create ATA - add instruction
      logger.log(`\n📝 Creating destination token account...`);
    }
  } catch (e) {
    // Will create ATA inline
    destTokenAccount = await getAssociatedTokenAddress(SYN_MINT(), destination, true);
  }
  
  const amountLamports = Math.floor(amount * 1_000_000_000);
  
  logger.log(`\n📤 Withdrawing ${amount} SYN to ${destinationAddress}...`);
  
  const transferIx = createTransferInstruction(
    sourceTokenAccount,
    destTokenAccount,
    wallet.publicKey,
    amountLamports
  );
  
  // If the destination SYN ATA doesn't exist we prepend a createATA ix so
  // the SPL transfer has a target. Without this the tx fails silently and
  // the user retries → "already processed" confusion.
  const preIxs: TransactionInstruction[] = [];
  const destAtaInfo = await connection.getAccountInfo(destTokenAccount);
  if (!destAtaInfo) {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    preIxs.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        destTokenAccount,
        destination,
        SYN_MINT(),
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    logger.log(`   Destination ATA missing — will create it in the same tx`);
  }

  const tx = new Transaction().add(...preIxs, transferIx);
  const signature = await sendAndConfirmFresh(connection, tx, [wallet]);

  logger.log(`✅ Withdraw successful!`);
  logger.log(`   Transaction: ${signature}`);

  return signature;
}

// Get stake info
export async function getStakeInfo(): Promise<{
  amount: number;
  tier: number;
  rewardsPending: number;
  lockedUntil: number;
} | null> {
  const wallet = await loadWalletWithPassword();
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  
  const stakeAccountAddress = await findStakeAccount(connection, wallet.publicKey);
  
  if (!stakeAccountAddress) {
    return null;
  }
  
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(stakeAccountAddress));
    if (!accountInfo) {
      return null;
    }
    
    const data = accountInfo.data;
    
    // StakeAccount layout (after 8-byte Anchor discriminator):
    // [8-39]   owner: Pubkey (32)
    // [40-71]  coordinator_authority: Pubkey (32)
    // [72-79]  amount: u64 (8)
    // [80]     tier: u8 (1)
    // [81-88]  lm: u64 (8)
    // [89]     ban_times: u8 (1)
    // [90-97]  banned_until: i64 (8)
    // [98-161] ban_reason: [u8; 64] (64)
    // [162-169] locked_until: i64 (8)
    // [170-177] rewards_pending: u64 (8)
    // [178-185] last_claim_at: i64 (8)
    // [186-193] last_accrual_at: i64 (8)
    const amount = Number(data.readBigUInt64LE(72)) / 1_000_000_000;
    const tier = data.readUInt8(80);
    const lockedUntil = Number(data.readBigInt64LE(162));
    const rewardsPending = Number(data.readBigUInt64LE(170)) / 1_000_000_000;
    
    return {
      amount,
      tier,
      rewardsPending,
      lockedUntil
    };
  } catch (e) {
    logger.error('Error fetching stake info:', e);
    return null;
  }
}

// Get wallet balance (SOL and SYN)
export async function getWalletBalance(): Promise<{
  sol: number;
  syn: number;
}> {
  const wallet = await loadWalletWithPassword();
  const connection = new Connection(SOLANA_RPC_URL_GETTER(), 'confirmed');
  
  const solBalance = await connection.getBalance(wallet.publicKey);
  const sol = solBalance / 1_000_000_000;
  
  let syn = 0;
  try {
    const tokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
    const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
    syn = Number(tokenBalance.value.uiAmountString);
  } catch (e) {
    // No token account yet
  }
  
  return { sol, syn };
}

// Find stake account for wallet
async function findStakeAccount(connection: Connection, owner: PublicKey): Promise<string | null> {
  try {
    const accounts = await connection.getProgramAccounts(STAKING_PROGRAM_ID(), {
      filters: [
        {
          memcmp: {
            offset: 8,
            bytes: owner.toBase58()
          }
        }
      ]
    });
    
    if (accounts.length > 0) {
      return accounts[0].pubkey.toBase58();
    }
  } catch (e) {
    logger.warn('Failed to search stake accounts:', e);
  }
  
  return null;
}
