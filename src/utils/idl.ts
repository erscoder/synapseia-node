/**
 * IDL helpers for Solana programs
 * Derive PDA addresses for staking, token, and escrow programs
 *
 * NOTE: Program IDs are resolved lazily (on first access) so that importing
 * this module does NOT throw when staking env vars are absent — e.g. when
 * the CLI runs `--help` or non-staking commands.
 */

import { PublicKey } from '@solana/web3.js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`${key} not informed`);
  return val;
}

function lazyPublicKey(envKey: string): () => PublicKey {
  let cached: PublicKey | undefined;
  return () => {
    if (!cached) cached = new PublicKey(requireEnv(envKey));
    return cached;
  };
}

// Lazy getters — no error at import time
const getStakingProgramId  = lazyPublicKey('STAKING_PROGRAM_ID');
const getTokenProgramId    = lazyPublicKey('TOKEN_PROGRAM_ID');
const getEscrowProgramId   = lazyPublicKey('ESCROW_PROGRAM_ID');

// Re-export as getters so callers keep the same `STAKING_PROGRAM_ID` name
export const STAKING_PROGRAM_ID: PublicKey = new Proxy({} as PublicKey, {
  get: (_t, prop) => Reflect.get(getStakingProgramId(), prop),
});
export const TOKEN_PROGRAM_ID: PublicKey = new Proxy({} as PublicKey, {
  get: (_t, prop) => Reflect.get(getTokenProgramId(), prop),
});
export const ESCROW_PROGRAM_ID: PublicKey = new Proxy({} as PublicKey, {
  get: (_t, prop) => Reflect.get(getEscrowProgramId(), prop),
});

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
    getStakingProgramId(),
  );
}

/**
 * Derive token mint address
 */
export function deriveTokenMint(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_MINT_SEED)],
    getTokenProgramId(),
  );
}

/**
 * Derive escrow account address
 */
export function deriveEscrowAccount(peerId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), Buffer.from(peerId)],
    getEscrowProgramId(),
  );
}

/**
 * Get all program IDs
 */
export function getAllProgramIds() {
  return {
    staking: getStakingProgramId(),
    token: getTokenProgramId(),
    escrow: getEscrowProgramId(),
  };
}
