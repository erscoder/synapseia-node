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

// IDs from .env — resolved lazily to avoid top-level throw when env is not set
function requireEnvPublicKey(key: string): PublicKey {
  const val = process.env[key];
  if (!val) throw new Error(`${key} not informed`);
  return new PublicKey(val);
}
function requireEnv(key: string, fallback?: string): string {
  const val = process.env[key];
  if (!val && fallback === undefined) throw new Error(`${key} not informed`);
  return val ?? fallback!;
}

const getStakingProgramId = () => requireEnvPublicKey('STAKING_PROGRAM_ID');
const getSynMint = () => requireEnvPublicKey('SYN_TOKEN_MINT');
const getSolanaRpcUrl = () => requireEnv('SOLANA_RPC_URL');
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:3701';
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
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

// Derive encryption key from password
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

// Decrypt wallet
function decryptWallet(encryptedData: string, password: string): Uint8Array {
  const combined = Buffer.from(encryptedData, 'base64');
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  
  return new Uint8Array(decrypted);
}

// Load and decrypt wallet
export async function loadWalletWithPassword(): Promise<Keypair> {
  const walletFile = WALLET_FILE();
  
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet not found at ${walletFile}. Run 'synapseia-node setup' first.`);
  }
  
  const walletData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
  
  // Check if encrypted
  if (!walletData.encryptedData) {
    // Unencrypted wallet - load directly
    const secretKey = new Uint8Array(walletData.secretKey);
    return Keypair.fromSecretKey(secretKey);
  }
  
  // Encrypted wallet — honour the env var first so the desktop UI (and any
  // other non-interactive caller) can pass the password without a TTY. This
  // was the root cause of `balance`/`stake`/`withdraw` hanging when Tauri
  // spawned the CLI: stdin is piped to null, so the @inquirer prompt blocked
  // forever.
  const envPassword = process.env.SYNAPSEIA_WALLET_PASSWORD ?? process.env.WALLET_PASSWORD;
  const walletPassword = envPassword
    ? envPassword
    : await password({ message: 'Enter wallet password:', mask: '*' });

  try {
    const secretKey = decryptWallet(walletData.encryptedData, walletPassword);
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

    const initIx = new TransactionInstruction({
      programId: STAKING_PROGRAM_ID(),
      data: createInitializeStakeInstructionData(1), // tier 1 = minimum valid (contract requires 1-5)
      keys: [
        { pubkey: stakeAccount.publicKey, isSigner: true, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(coordinatorAuthority), isSigner: false, isWritable: false },
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

  const stakeTx = new Transaction().add(stakeIx);
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
  
  const data = accountInfo.data;
  const rewardsPending = data.readBigUInt64LE(170); // offset: 8 disc + 32 owner + 32 coord_auth + 8 amount + 1 tier + 8 lm + 1 ban_times + 8 banned_until + 64 ban_reason + 8 locked_until = 170
  const rewards = Number(rewardsPending) / 1_000_000_000;
  
  if (rewards <= 0) {
    logger.log(`ℹ️ No pending rewards to claim.`);
    return '';
  }
  
  logger.log(`\n💰 Claiming ${rewards} SYN in rewards...`);

  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  const [treasuryAuthority] = getTreasuryAuthorityPDA();
  const treasuryTokenAccount = await getTreasuryTokenAccount(connection);
  const [stakingPool] = getStakingPoolPDA();

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
