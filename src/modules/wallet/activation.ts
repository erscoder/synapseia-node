/**
 * Node Activation Service
 *
 * Handles the SYN token account activation flow:
 * 1. Check if wallet already has a SYN token account
 * 2. If not, wait for user to deposit 0.05 SOL
 * 3. Poll SOL balance every 30 seconds
 * 4. Once confirmed, create the SYN token account
 * 5. Proceed with node startup
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import logger from '../../utils/logger';

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const SYN_TOKEN_MINT =
  process.env.SYN_TOKEN_MINT || 'DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8';
const ACTIVATION_DEPOSIT_SOL = 0.05;
const POLL_INTERVAL_MS = 30_000;

export interface ActivationStatus {
  activated: boolean;
  synTokenAccount?: string;
  error?: string;
}

/**
 * Check if a wallet already has a SYN token account with a balance
 */
export async function hasSynTokenAccount(
  walletAddress: string,
): Promise<{ hasAccount: boolean; tokenAccount?: string }> {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(SYN_TOKEN_MINT);

    const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, {
      mint: mintPubkey,
    });

    if (tokenAccounts.value.length === 0) {
      return { hasAccount: false };
    }

    return {
      hasAccount: true,
      tokenAccount: tokenAccounts.value[0].pubkey.toBase58(),
    };
  } catch (err) {
    logger.error(`[Activation] Error checking SYN token account: ${(err as Error).message}`);
    return { hasAccount: false };
  }
}

/**
 * Get SOL balance for a wallet address
 */
export async function getSolBalance(walletAddress: string): Promise<number> {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const pubkey = new PublicKey(walletAddress);
    const balance = await connection.getBalance(pubkey);
    return balance / 1e9; // lamports → SOL
  } catch {
    return 0;
  }
}

/**
 * Create a SYN token account for the given wallet using the payer.
 * The payer (creator) needs to fund the new account's rent.
 *
 * @param walletAddress - The wallet that will own the new token account
 * @param payerKeypair  - The keypair that will fund and sign the transaction
 *                        (typically the same as walletAddress)
 */
export async function createSynTokenAccount(
  walletAddress: string,
  payerKeypair: Keypair,
): Promise<{ success: boolean; tokenAccount?: string; error?: string }> {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(SYN_TOKEN_MINT);

    const tokenAccount = await getAssociatedTokenAddress(mint, wallet);
    const createIx = createAssociatedTokenAccountInstruction(
      payerKeypair.publicKey, // payer
      tokenAccount, // new account address
      wallet, // owner
      mint, // mint
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction().add(createIx);
    const sig = await connection.sendTransaction(tx, [payerKeypair], {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, 'confirmed');

    logger.log(`[Activation] SYN token account created: ${tokenAccount.toBase58()}`);
    logger.log(`[Activation] Transaction: ${sig}`);

    return { success: true, tokenAccount: tokenAccount.toBase58() };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`[Activation] Failed to create SYN token account: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Wait for the activation deposit by polling SOL balance every 30s.
 * Returns once the wallet has ≥ ACTIVATION_DEPOSIT_SOL SOL.
 * Shows a message explaining why the deposit is needed.
 */
export async function waitForActivationDeposit(
  walletAddress: string,
  onPoll: (balance: number) => void,
): Promise<{ received: boolean }> {
  logger.log("");
  logger.log("  ╔══════════════════════════════════════════════════════╗");
  logger.log("  ║              ⚠️  NODE ACTIVATION REQUIRED               ║");
  logger.log("  ╠══════════════════════════════════════════════════════╣");
  logger.log("  ║ To receive SYN rewards your wallet needs a SPL       ║");
  logger.log("  ║ token account. One-time SOL deposit required for     ║");
  logger.log("  ║ rent exemption.                                     ║");
  logger.log("  ║                                                        ║");
  logger.log("  ║  Please deposit 0.05 SOL to activate your node.      ║");
  logger.log("  ║                                                        ║");
  const shortAddr = walletAddress.length > 44
    ? walletAddress.slice(0, 8) + '...' + walletAddress.slice(-6)
    : walletAddress;
  logger.log(`  ║  Wallet: ${shortAddr}                                 ║`);
  logger.log("  ║                                                        ║");
  logger.log("  ║  Checking every 30s until deposit confirmed...        ║");
  logger.log("  ║  Transfer SOL, then restart node to activate.        ║");
  logger.log("  ║                                                        ║");
  logger.log("  ╚══════════════════════════════════════════════════════╝");
  logger.log("");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const balance = await getSolBalance(walletAddress);
    onPoll(balance);

    if (balance >= ACTIVATION_DEPOSIT_SOL) {
      logger.log(`[Activation] ${balance.toFixed(4)} SOL detected — proceeding with activation`);
      return { received: true };
    }

    const needed = ACTIVATION_DEPOSIT_SOL - balance;
    logger.log(`[Activation] Current balance: ${balance.toFixed(4)} SOL — waiting for ${needed.toFixed(4)} more SOL...`);

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Full activation flow:
 * 1. Check if already activated (has SYN token account)
 * 2. If not, wait for 0.05 SOL deposit
 * 3. Create SYN token account
 * 4. Return activation status
 */
export async function activateNode(
  walletAddress: string,
  payerKeypair: Keypair,
): Promise<ActivationStatus> {
  // Step 1: Already activated?
  const { hasAccount, tokenAccount } = await hasSynTokenAccount(walletAddress);
  if (hasAccount && tokenAccount) {
    logger.log(`[Activation] SYN token account already exists: ${tokenAccount}`);
    return { activated: true, synTokenAccount: tokenAccount };
  }

  // Step 2: Wait for SOL deposit
  const { received } = await waitForActivationDeposit(walletAddress, () => {});
  if (!received) {
    return { activated: false, error: 'Deposit not received' };
  }

  // Step 3: Create SYN token account
  const result = await createSynTokenAccount(walletAddress, payerKeypair);
  if (!result.success) {
    return { activated: false, error: result.error };
  }

  return { activated: true, synTokenAccount: result.tokenAccount };
}
