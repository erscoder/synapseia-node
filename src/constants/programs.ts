/**
 * Canonical Solana addresses for the Synapseia on-chain programs.
 *
 * Single source of truth for the node CLI's on-chain wiring. Mirrors
 * the dashboard `.env.local` values and the `declare_id!` macros in
 * `packages/contracts/programs/*` (with one exception — SYN_TOKEN_MINT
 * is the mint *account* the syn_token program owns, not the program
 * id itself). Operators can override every value via the matching
 * env var so dev clusters / mainnet-flip flows work without code
 * changes.
 *
 * Synapseia is on devnet today; the constants below are devnet
 * addresses. The mainnet flip is a one-line change here plus a
 * coordinated dashboard / contracts redeploy.
 */
import { PublicKey } from '@solana/web3.js';

export const OFFICIAL_STAKING_PROGRAM_ID =
  'CYW5Cprp5JuzaXtPyV8LPBgPzbze6QHnc3oFBAVaFkfw';
export const OFFICIAL_REWARDS_VAULT_PROGRAM_ID =
  'D9pkzWv2Ak9J8vXDVcMM1P51hDmjRJEwbuYHxCuJKTEN';
export const OFFICIAL_ESCROW_PROGRAM_ID =
  'HwFPR5rGCkd7ak6SivRkaPnb5jzRMMHvC3wENK1mW2eK';
export const OFFICIAL_SYN_TOKEN_PROGRAM_ID =
  '8iFr3ciQuNeU4vkzQTp7NcWNgRr7AVhwyizNCAszaEQq';
export const OFFICIAL_SYN_TOKEN_MINT =
  'DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8';

// String getters honour env override; PublicKey getters wrap them.
export const getStakingProgramIdString = (): string =>
  process.env.STAKING_PROGRAM_ID?.trim() || OFFICIAL_STAKING_PROGRAM_ID;
export const getRewardsVaultProgramIdString = (): string =>
  process.env.REWARDS_VAULT_PROGRAM_ID?.trim() || OFFICIAL_REWARDS_VAULT_PROGRAM_ID;
export const getEscrowProgramIdString = (): string =>
  process.env.ESCROW_PROGRAM_ID?.trim() || OFFICIAL_ESCROW_PROGRAM_ID;
export const getSynTokenProgramIdString = (): string =>
  process.env.SYN_TOKEN_PROGRAM_ID?.trim() || OFFICIAL_SYN_TOKEN_PROGRAM_ID;
export const getSynTokenMintString = (): string =>
  process.env.SYN_TOKEN_MINT?.trim() || OFFICIAL_SYN_TOKEN_MINT;

export const getStakingProgramId = (): PublicKey =>
  new PublicKey(getStakingProgramIdString());
export const getRewardsVaultProgramId = (): PublicKey =>
  new PublicKey(getRewardsVaultProgramIdString());
export const getEscrowProgramId = (): PublicKey =>
  new PublicKey(getEscrowProgramIdString());
export const getSynTokenProgramId = (): PublicKey =>
  new PublicKey(getSynTokenProgramIdString());
export const getSynTokenMint = (): PublicKey =>
  new PublicKey(getSynTokenMintString());
