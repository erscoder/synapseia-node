/**
 * IDL helpers for Solana programs
 * Derive PDA addresses for staking, token, and escrow programs
 *
 * NOTE: Program IDs are resolved lazily (on first access) so that importing
 * this module does NOT construct PublicKeys at import time — e.g. when the
 * CLI runs `--help` or non-staking commands.
 *
 * Resolution is "env override, OFFICIAL constant fallback": each program id
 * defaults to the canonical devnet address from `../constants/programs`
 * (the single source of truth) so a fresh node works out-of-the-box with no
 * env vars set. Operators can still override via the matching env var for
 * dev clusters / mainnet-flip flows.
 *
 * The TOKEN_PROGRAM_ID resolver here points at the *custom* SYN token program
 * (OFFICIAL_SYN_TOKEN_PROGRAM_ID), NOT the standard SPL Token program — the
 * SYN token is deployed under its own token program.
 */

import { PublicKey } from '@solana/web3.js';
import {
  OFFICIAL_STAKING_PROGRAM_ID,
  OFFICIAL_SYN_TOKEN_PROGRAM_ID,
  OFFICIAL_ESCROW_PROGRAM_ID,
} from '../constants/programs';

function resolveEnvOrOfficial(envKey: string, official: string): string {
  return process.env[envKey]?.trim() || official;
}

function lazyPublicKey(envKey: string, official: string): () => PublicKey {
  let cached: PublicKey | undefined;
  return () => {
    if (!cached) cached = new PublicKey(resolveEnvOrOfficial(envKey, official));
    return cached;
  };
}

// Lazy getters — env override, OFFICIAL constant fallback, no construction at import time
const getStakingProgramId  = lazyPublicKey('STAKING_PROGRAM_ID', OFFICIAL_STAKING_PROGRAM_ID);
const getTokenProgramId    = lazyPublicKey('TOKEN_PROGRAM_ID', OFFICIAL_SYN_TOKEN_PROGRAM_ID);
const getEscrowProgramId   = lazyPublicKey('ESCROW_PROGRAM_ID', OFFICIAL_ESCROW_PROGRAM_ID);

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
