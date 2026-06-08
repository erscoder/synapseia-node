/**
 * On-chain claim of work-order rewards from the `syn_rewards_vault` program.
 *
 * Mirrors `packages/dashboard/features/solana/hooks/useRewardsVault.ts` but
 * uses raw `@solana/web3.js` (no Anchor) so the CLI bundle stays small and
 * doesn't duplicate the existing staking-cli pattern. See the IDL at
 * `packages/dashboard/features/solana/idl/syn_rewards_vault.json` for the
 * discriminator + account order used below.
 */

import {
  Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import logger from '../../utils/logger';
import { loadWalletWithPassword, sendAndConfirmFresh } from '../staking/staking-cli';
import {
  getRewardsVaultProgramId as resolveRewardsVaultProgramId,
  getRewardTokenMint as resolveRewardTokenMint,
} from '../../constants/programs';
import {
  buildClaimRewardsInstruction,
  deriveRewardAccountPDA,
  deriveTreasuryAuthorityPDA,
} from './rewards-vault-instruction';

const DEFAULT_CU_LIMIT = 1_400_000;
const DEFAULT_CU_PRICE_MICROLAMPORTS = 10_000;
// Reward payout mint is USDC (6 decimals), NOT SYN (9). The rewards-vault
// flipped SYN→USDC; the claimable u64 in the RewardAccount PDA is denominated
// in this mint's base units, so display divides by 1e6.
const REWARD_TOKEN_DECIMALS_DIVISOR = 1_000_000;

// Program id + mint resolution is centralised in `constants/programs.ts`
// so a future devnet→mainnet flip is a single-file change.
function getRewardsVaultProgramId(): PublicKey {
  return resolveRewardsVaultProgramId();
}

// Reward payout mint (USDC) — distinct from the SYN mint used by staking/faucet.
function getRewardMint(): PublicKey {
  return resolveRewardTokenMint();
}

function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
}

// PDA derivations + instruction builder live in `./rewards-vault-instruction`
// (pure helpers, no wallet/RPC deps, jest-friendly).

/**
 * Claim all pending work-order rewards from the rewards vault PDA to the
 * caller's associated token account. Returns the tx signature.
 *
 * Fails fast with a user-facing message when the wallet has nothing to claim
 * (no RewardAccount PDA or unclaimed == 0) so the UI can surface it without
 * paying gas on a no-op.
 */
export async function claimWorkOrderRewards(): Promise<string> {
  const programId = getRewardsVaultProgramId();
  const rewardMint = getRewardMint();

  const connection = new Connection(getSolanaRpcUrl(), 'confirmed');
  const wallet = await loadWalletWithPassword();
  const owner = wallet.publicKey;

  // Sanity: no reward account → nothing to claim. Cheaper than a failed tx.
  const rewardAccount = deriveRewardAccountPDA(owner, programId);
  const rewardInfo = await connection.getAccountInfo(rewardAccount, 'confirmed');
  if (!rewardInfo || rewardInfo.data.length < 8 + 32 + 8) {
    throw new Error(
      'No reward account on-chain yet. Run your node and earn rewards first.',
    );
  }
  const unclaimed =
    Number(rewardInfo.data.readBigUInt64LE(8 + 32)) / REWARD_TOKEN_DECIMALS_DIVISOR;
  if (unclaimed === 0) {
    throw new Error('Claimable balance is zero — nothing to claim.');
  }
  logger.log(`Claimable balance: ${unclaimed} USDC`);

  const treasuryAuthority = deriveTreasuryAuthorityPDA(programId);
  const treasuryTokenAccount = await getAssociatedTokenAddress(
    rewardMint,
    treasuryAuthority,
    true, // allowOwnerOffCurve — treasuryAuthority is a PDA
  );
  const ownerTokenAccount = await getAssociatedTokenAddress(rewardMint, owner);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_CU_PRICE_MICROLAMPORTS }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_LIMIT }),
  ];

  // Create the owner's reward (USDC) ATA when it doesn't exist yet — the
  // program transfers into it, so it must be initialised beforehand.
  const ownerAtaInfo = await connection.getAccountInfo(ownerTokenAccount);
  if (!ownerAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        owner, ownerTokenAccount, owner, rewardMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  // 8-account `claim_rewards` instruction. See buildClaimRewardsInstruction
  // for full slot ordering — pause_state in slot 1 is mandatory (omitting it
  // shifts reward_account into the pause_state slot and the program rejects
  // with AccountDiscriminatorMismatch).
  instructions.push(buildClaimRewardsInstruction({
    programId,
    owner,
    treasuryTokenAccount,
    ownerTokenAccount,
  }));

  const tx = new Transaction().add(...instructions);
  return sendAndConfirmFresh(connection, tx, [wallet]);
}
