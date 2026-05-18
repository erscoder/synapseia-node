/**
 * Solana balance helpers for the CLI
 * Fetches SYN token balance and staked amount from devnet
 */

import { Injectable } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { getCoordinatorUrl } from '../../constants/coordinator';

// SYN token mint on devnet (from coordinator .env)
const SYN_TOKEN_MINT = process.env.SYN_TOKEN_MINT || 'DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8';
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  'https://api.devnet.solana.com';

@Injectable()
export class SolanaBalanceHelper {
  /**
   * Get SPL token balance for a wallet address
   * Returns balance in SYN tokens (9 decimals)
   */
  async getSynBalance(walletAddress: string): Promise<number> {
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
  async getStakedAmount(
    // Bug 40 (0.8.91) — default param evaluated at call time, returns
    // OFFICIAL_COORDINATOR_URL when COORDINATOR_URL env is unset instead
    // of the dev-only localhost:3701 fallback.
    walletAddress: string,
    coordinatorUrl: string = getCoordinatorUrl(),
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
  async stakeTokens(
    // Bug 40 (0.8.91) — see getStakedAmount note above.
    walletAddress: string,
    amount: string,
    coordinatorUrl: string = getCoordinatorUrl(),
  ): Promise<{ success: boolean; txSignature?: string; stakeAddress?: string; error?: string }> {
    try {
      const res = await fetch(`${coordinatorUrl}/stake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, amount }),
      });
      if (!res.ok) {
        const err = await res.json() as { message?: string };
        return { success: false, error: err.message || 'Stake failed' };
      }
      const data = await res.json() as { txSignature?: string; stakeAddress?: string };
      return { success: true, txSignature: data.txSignature, stakeAddress: data.stakeAddress };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}

// Backward-compatible standalone function exports
export const getSynBalance = (...args: Parameters<SolanaBalanceHelper['getSynBalance']>) =>
  new SolanaBalanceHelper().getSynBalance(...args);

export const getStakedAmount = (...args: Parameters<SolanaBalanceHelper['getStakedAmount']>) =>
  new SolanaBalanceHelper().getStakedAmount(...args);

export const stakeTokens = (...args: Parameters<SolanaBalanceHelper['stakeTokens']>) =>
  new SolanaBalanceHelper().stakeTokens(...args);
