/**
 * On-chain staking operations for CLI
 * Implements stake, unstake, claimRewards, deposit, and withdraw using raw Solana transactions
 */

import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import logger from '../../utils/logger.js';
import { getAssociatedTokenAddress, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createTransferInstruction } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { input, password } from '@inquirer/prompts';

// IDs from .env
if (!process.env.STAKING_PROGRAM_ID) throw new Error('STAKING_PROGRAM_ID not informed');
const STAKING_PROGRAM_ID = new PublicKey(process.env.STAKING_PROGRAM_ID);
if (!process.env.SYN_TOKEN_MINT) throw new Error('SYN_TOKEN_MINT not informed');
const SYN_MINT = new PublicKey(process.env.SYN_TOKEN_MINT);
if (!process.env.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL not informed');
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:3001';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Derive vault authority PDA
function getVaultAuthorityPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake_vault_authority')],
    STAKING_PROGRAM_ID
  );
}

// Get stake vault ATA
async function getStakeVaultATA(connection: Connection): Promise<PublicKey> {
  const [vaultAuthority] = getVaultAuthorityPDA();
  return getAssociatedTokenAddress(SYN_MINT, vaultAuthority, true);
}

// Get treasury authority PDA
function getTreasuryAuthorityPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury_authority')],
    STAKING_PROGRAM_ID
  );
}

// Get treasury token account
async function getTreasuryTokenAccount(connection: Connection): Promise<PublicKey> {
  const [treasuryAuthority] = getTreasuryAuthorityPDA();
  return getAssociatedTokenAddress(SYN_MINT, treasuryAuthority, true);
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
async function loadWalletWithPassword(): Promise<Keypair> {
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
  
  // Encrypted wallet - ask for password
  const walletPassword = await password({
    message: 'Enter wallet password:',
    mask: '*'
  });
  
  try {
    const secretKey = decryptWallet(walletData.encryptedData, walletPassword);
    return Keypair.fromSecretKey(secretKey);
  } catch (e) {
    throw new Error('Invalid password or corrupted wallet file');
  }
}

// Get user's SYN token account
async function getUserTokenAccount(connection: Connection, wallet: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(SYN_MINT, wallet);
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
  
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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

    // initialize_stake requires coordinator_authority co-signature.
    // We build the tx, sign with wallet + stake_account, then ask the coordinator to add its sig.
    const { blockhash } = await connection.getLatestBlockhash();

    // Fetch coordinator authority pubkey from coordinator
    const coordInfoRes = await fetch(`${COORDINATOR_URL}/stake/coordinator-authority`);
    if (!coordInfoRes.ok) throw new Error(`Failed to get coordinator authority: ${coordInfoRes.status}`);
    const { coordinatorAuthority } = await coordInfoRes.json() as { coordinatorAuthority: string };

    const initIx = new TransactionInstruction({
      programId: STAKING_PROGRAM_ID,
      data: createInitializeStakeInstructionData(0),
      keys: [
        { pubkey: stakeAccount.publicKey, isSigner: true, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(coordinatorAuthority), isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ]
    });

    const initTx = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey }).add(initIx);
    // User + stake account sign first
    initTx.partialSign(wallet, stakeAccount);

    // Send to coordinator for co-signature
    const partialSerialized = initTx.serialize({ requireAllSignatures: false }).toString('base64');
    const signRes = await fetch(`${COORDINATOR_URL}/stake/sign-initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: partialSerialized }),
    });
    if (!signRes.ok) {
      const err = await signRes.json().catch(() => ({}));
      throw new Error(`Coordinator refused to co-sign: ${JSON.stringify(err)}`);
    }
    const { transaction: fullySigned } = await signRes.json() as { transaction: string };

    const rawTx = Buffer.from(fullySigned, 'base64');
    const initSig = await connection.sendRawTransaction(rawTx, { skipPreflight: false });
    await connection.confirmTransaction(initSig, 'confirmed');

    logger.log(`   Stake account created: ${initSig}`);
  } else {
    stakeAccountPubkey = new PublicKey(stakeAccountAddress);
  }
  
  // Get token accounts
  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  const stakeVault = await getStakeVaultATA(connection);
  const [vaultAuthority] = getVaultAuthorityPDA();
  
  logger.log(`\n📤 Staking ${amount} SYN tokens...`);
  
  const stakeIx = new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    data: createStakeInstructionData(amount),
    keys: [
      { pubkey: stakeAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: stakeVault, isSigner: false, isWritable: true },
      { pubkey: SYN_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }
    ]
  });
  
  const stakeTx = new Transaction().add(stakeIx);
  const tx = await connection.sendTransaction(stakeTx, [wallet], {
    skipPreflight: false
  });
  
  logger.log(`✅ Stake successful!`);
  logger.log(`   Transaction: ${tx}`);
  
  return tx;
}

// Unstake SYN tokens
export async function unstakeTokens(amount: number): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  // Find stake account
  const stakeAccountAddress = await findStakeAccount(connection, wallet.publicKey);
  
  if (!stakeAccountAddress) {
    throw new Error('No stake account found. Have you staked any tokens?');
  }
  
  const stakeAccount = new PublicKey(stakeAccountAddress);
  
  // Get token accounts
  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  const stakeVault = await getStakeVaultATA(connection);
  const [vaultAuthority] = getVaultAuthorityPDA();
  
  logger.log(`\n📥 Unstaking ${amount} SYN tokens...`);
  
  const unstakeIx = new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    data: createUnstakeInstructionData(amount),
    keys: [
      { pubkey: stakeAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: stakeVault, isSigner: false, isWritable: true },
      { pubkey: SYN_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }
    ]
  });
  
  const unstakeTx = new Transaction().add(unstakeIx);
  const tx = await connection.sendTransaction(unstakeTx, [wallet], {
    skipPreflight: false
  });
  
  logger.log(`✅ Unstake successful!`);
  logger.log(`   Transaction: ${tx}`);
  
  return tx;
}

// Claim rewards
export async function claimStakingRewards(): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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
  const rewardsPending = data.readBigUInt64LE(40);
  const rewards = Number(rewardsPending) / 1_000_000_000;
  
  if (rewards <= 0) {
    logger.log(`ℹ️ No pending rewards to claim.`);
    return '';
  }
  
  logger.log(`\n💰 Claiming ${rewards} SYN in rewards...`);
  
  const userTokenAccount = await getUserTokenAccount(connection, wallet.publicKey);
  const [treasuryAuthority] = getTreasuryAuthorityPDA();
  const treasuryTokenAccount = await getTreasuryTokenAccount(connection);
  
  const claimIx = new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    data: createClaimRewardsInstructionData(),
    keys: [
      { pubkey: new PublicKey(stakeAccountAddress), isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: treasuryAuthority, isSigner: false, isWritable: false },
      { pubkey: SYN_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }
    ]
  });
  
  const claimTx = new Transaction().add(claimIx);
  const tx = await connection.sendTransaction(claimTx, [wallet], {
    skipPreflight: false
  });
  
  logger.log(`✅ Rewards claimed!`);
  logger.log(`   Transaction: ${tx}`);
  
  return tx;
}

// Deposit SOL (airdrop for devnet)
export async function depositSol(amount: number): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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
  
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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
  
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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
  
  const signature = await connection.sendTransaction(tx, [wallet], {
    skipPreflight: false
  });
  
  logger.log(`✅ Withdraw successful!`);
  logger.log(`   Transaction: ${signature}`);
  
  return signature;
}

// Withdraw SYN
export async function withdrawSyn(amount: number, destinationAddress: string): Promise<string> {
  logger.log(`\n🔄 Connecting to Solana...`);
  
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const wallet = await loadWalletWithPassword();
  
  logger.log(`✅ Connected. Wallet: ${wallet.publicKey.toBase58()}`);
  
  const destination = new PublicKey(destinationAddress);
  
  // Get source ATA
  const sourceTokenAccount = await getAssociatedTokenAddress(SYN_MINT, wallet.publicKey);
  
  // Get or create destination ATA
  let destTokenAccount: PublicKey;
  try {
    destTokenAccount = await getAssociatedTokenAddress(SYN_MINT, destination);
    
    // Check if destination ATA exists
    const destAccountInfo = await connection.getAccountInfo(destTokenAccount);
    if (!destAccountInfo) {
      // Need to create ATA - add instruction
      logger.log(`\n📝 Creating destination token account...`);
    }
  } catch (e) {
    // Will create ATA inline
    destTokenAccount = await getAssociatedTokenAddress(SYN_MINT, destination, true);
  }
  
  const amountLamports = Math.floor(amount * 1_000_000_000);
  
  logger.log(`\n📤 Withdrawing ${amount} SYN to ${destinationAddress}...`);
  
  const transferIx = createTransferInstruction(
    sourceTokenAccount,
    destTokenAccount,
    wallet.publicKey,
    amountLamports
  );
  
  const tx = new Transaction().add(transferIx);
  const signature = await connection.sendTransaction(tx, [wallet], {
    skipPreflight: false
  });
  
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
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  
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
    
    const amount = Number(data.readBigUInt64LE(40)) / 1_000_000_000;
    const tier = data.readUInt8(48);
    const rewardsPending = Number(data.readBigUInt64LE(66)) / 1_000_000_000;
    const lockedUntil = Number(data.readBigUInt64LE(58));
    
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
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  
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
    const accounts = await connection.getProgramAccounts(STAKING_PROGRAM_ID, {
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
