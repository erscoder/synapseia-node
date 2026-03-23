/**
 * IDL helpers for Solana programs
 * Derive PDA addresses for staking, token, and escrow programs
 */

import { PublicKey } from '@solana/web3.js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`${key} not informed`);
  return val;
}

// Program IDs — must be set via environment variables, no hardcoded fallbacks
export const STAKING_PROGRAM_ID = new PublicKey(requireEnv('STAKING_PROGRAM_ID'));
export const TOKEN_PROGRAM_ID   = new PublicKey(requireEnv('TOKEN_PROGRAM_ID'));
export const ESCROW_PROGRAM_ID  = new PublicKey(requireEnv('ESCROW_PROGRAM_ID'));
// Rewards will be deployed as part of EPIC 5 - use placeholder for now
export const REWARDS_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// Common PDA seeds
export const STAKE_SEED = 'stake';
export const TOKEN_MINT_SEED = 'token_mint';
export const ESCROW_SEED = 'escrow';

/**
 * Derive stake account address for a peer
 */
export function deriveStakeAccount(peerId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(STAKE_SEED), Buffer.from(peerId)],
    STAKING_PROGRAM_ID,
  );
}

/**
 * Derive token mint address
 */
export function deriveTokenMint(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_MINT_SEED)],
    TOKEN_PROGRAM_ID,
  );
}

/**
 * Derive escrow account address
 */
export function deriveEscrowAccount(peerId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), Buffer.from(peerId)],
    ESCROW_PROGRAM_ID,
  );
}

/**
 * Get all program IDs
 */
export function getAllProgramIds() {
  return {
    staking: STAKING_PROGRAM_ID,
    token: TOKEN_PROGRAM_ID,
    escrow: ESCROW_PROGRAM_ID,
  };
}
