/**
 * Solana balance helpers for the CLI
 * Fetches SYN token balance and staked amount from devnet
 */

import { Connection, PublicKey } from '@solana/web3.js';

// SYN token mint on devnet (from coordinator .env)
const SYN_TOKEN_MINT = process.env.SYN_TOKEN_MINT || 'DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8';
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  'https://api.devnet.solana.com';

/**
 * Get SPL token balance for a wallet address
 * Returns balance in SYN tokens (9 decimals)
 */
export async function getSynBalance(walletAddress: string): Promise<number> {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(SYN_TOKEN_MINT);

    const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, {
      mint: mintPubkey,
    });

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    // Sum all token accounts (should usually be just one)
    let totalBalance = BigInt(0);
    for (const account of tokenAccounts.value) {
      const info = await connection.getTokenAccountBalance(account.pubkey);
      const amount = info.value.amount;
      totalBalance += BigInt(amount);
    }

    // Convert from lamports (9 decimals) to SYN
    return Number(totalBalance) / 1e9;
  } catch {
    return 0;
  }
}

/**
 * Get staked SYN amount for a wallet via coordinator API
 */
export async function getStakedAmount(
  walletAddress: string,
  coordinatorUrl: string = 'http://localhost:3001',
): Promise<number> {
  try {
    const res = await fetch(`${coordinatorUrl}/stake/staker/${encodeURIComponent(walletAddress)}`);
    if (!res.ok) return 0;
    const data = await res.json() as { totalStaked?: string };
    return parseFloat(data.totalStaked || '0');
  } catch {
    return 0;
  }
}

/**
 * Stake SYN tokens via coordinator API
 */
export async function stakeTokens(
  walletAddress: string,
  amount: string,
  coordinatorUrl: string = 'http://localhost:3001',
): Promise<{ success: boolean; txSignature?: string; stakeAddress?: string; error?: string }