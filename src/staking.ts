/**
 * Staking verification (A11)
 * Connects to Solana staking program to verify stake amount
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { STAKING_PROGRAM_ID } from './utils/idl.js';

// Derive stake account inline to avoid dependency issues
function deriveStakeAccount(peerId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake'), Buffer.from(peerId)],
    STAKING_PROGRAM_ID,
  );
}

export interface StakeInfo {
  peerId: string;
  stakedAmount: number; // In SYN tokens
  tier: number;
  stakeAccount: string;
  lockupEndTimestamp: number | null;
}

export interface StakingVerificationResult {
  valid: boolean;
  stakeInfo?: StakeInfo;
  error?: string;
}

/**
 * Verify stake for a peer on the blockchain
 */
export async function verifyStake(
  peerId: string,
  rpcUrl: string = 'https://api.devnet.solana.com',
): Promise<StakingVerificationResult> {
  try {
    const connection = new Connection(rpcUrl);
    const [stakeAccount] = deriveStakeAccount(peerId);

    // Fetch account info
    const accountInfo = await connection.getAccountInfo(stakeAccount);

    if (!accountInfo || !accountInfo?.data) {
      return {
        valid: false,
        error: 'Stake account not found',
      };
    }

    // Parse IDL data (simplified - in production, use anchor client)
    const stakeData = parseStakeAccountData(accountInfo.data);

    const stakeInfo: StakeInfo = {
      peerId,
      stakedAmount: stakeData.amount,
      tier: computeTier(stakeData.amount),
      stakeAccount: Array.isArray(stakeAccount) ? stakeAccount[0].toBase58() : String(stakeAccount),
      lockupEndTimestamp: stakeData.lockupEnd,
    };

    return {
      valid: true,
      stakeInfo,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get minimum stake for each tier (in SYN tokens)
 */
export function getMinimumStake(tier: number): number {
  const minimums: Record<number, number> = {
    0: 0, // CPU-only, no stake required
    1: 100,
    2: 500,
    3: 1000,
    4: 5000,
    5: 10000,
  };
  return minimums[tier] || 0;
}

/**
 * Compute tier based on staked amount
 */
export function computeTier(stakedAmount: number): number {
  if (stakedAmount < 100) return 0;
  if (stakedAmount < 500) return 1;
  if (stakedAmount < 1000) return 2;
  if (stakedAmount < 5000) return 3;
  if (stakedAmount < 10000) return 4;
  return 5;
}

/**
 * Check if stake meets minimum for tier
 */
export function meetsMinimumStake(stakedAmount: number, tier: number): boolean {
  const minimum = getMinimumStake(tier);
  return stakedAmount >= minimum;
}

/**
 * Parse stake account data from raw bytes
 * Simplified parser - in production, use anchor IDL deserializer
 */
function parseStakeAccountData(data: Buffer): {
  amount: number;
  lockupEnd: number | null;
  owner: string;
} {
  // This is a simplified parser. In production, use:
  // import { Program, AnchorProvider } from '@project-serum/anchor';
  // const program = new Program(idl, provider);
  // const account = program.account.stakeAccount.fetch(address);

  // For now, return dummy data based on account size
  if (data.length < 8) {
    throw new Error('Invalid stake account data');
  }

  // Read amount (u64) - simplified
  const amount = data.readBigUInt64LE(0);

  return {
    amount: Number(amount),
    lockupEnd: data.length > 16 ? Number(data.readBigUInt64LE(8)) : null,
    owner: 'placeholder', // Would parse from account data
  };
}

/**
 * Get all stakes for a peer (if multiple stake accounts exist)
 */
export async function getAllStakesForPeer(
  peerId: string,
  rpcUrl: string = 'https://api.devnet.solana.com',
): Promise<StakeInfo[]> {
  // For now, return single stake
  const result = await verifyStake(peerId, rpcUrl);
  return result.valid && result.stakeInfo ? [result.stakeInfo] : [];
}

/**
 * Get total staked across network (aggregates all stake accounts)
 */
export async function getTotalNetworkStake(
  rpcUrl: string = 'https://api.devnet.solana.com',
): Promise<number> {
  try {
    const connection = new Connection(rpcUrl);
    const programAccounts = await connection.getProgramAccounts(
      STAKING_PROGRAM_ID,
      {
        filters: [
          // Account size filter for stake accounts
          { dataSize: 32 }, // Simplified filter
        ],
      },
    );

    let totalStake = 0;
    for (const account of programAccounts) {
      const data = parseStakeAccountData(account.account.data);
      totalStake += data.amount;
    }

    return totalStake;
  } catch (error) {
    return 0;
  }
}
