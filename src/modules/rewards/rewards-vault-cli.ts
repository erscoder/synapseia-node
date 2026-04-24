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

const DEFAULT_CU_LIMIT = 1_400_000;
const DEFAULT_CU_PRICE_MICROLAMPORTS = 10_000;

const REWARDS_VAULT_PROGRAM_ID_DEFAULT =
  'D9pkzWv2Ak9J8vXDVcMM1P51hDmjRJEwbuYHxCuJKTEN';
const SYN_TOKEN_MINT_DEFAULT = 'DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8';

function getRewardsVaultProgramId(): PublicKey {
  return new PublicKey(
    process.env.REWARDS_VAULT_PROGRAM_ID ?? REWARDS_VAULT_PROGRAM_ID_DEFAULT,
  );
}

function getSynMint(): PublicKey {
  return new PublicKey(process.env.SYN_TOKEN_MINT ?? SYN_TOKEN_MINT_DEFAULT);
}

function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
}

function deriveVaultStatePDA(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault_state')],
    programId,
  )[0];
}

function deriveRewardAccountPDA(owner: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reward_account'), owner.toBuffer()],
    programId,
  )[0];
}

function deriveTreasuryAuthorityPDA(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rewards_treasury')],
    programId,
  )[0];
}

function createClaimRewardsInstructionData(): Buffer {
  // IDL discriminator for `claim_rewards` — no args.
  return Buffer.from([4, 144, 132, 71, 116, 23, 151, 80]);
}

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
  const synMint = getSynMint();

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
  const unclaimed = Number(rewardInfo.data.readBigUInt64LE(8 + 32)) / 1_000_000_000;
  if (unclaimed === 0) {
    throw new Error('Claimable balance is zero — nothing to claim.');
  }
  logger.log(`Claimable balance: ${unclaimed} SYN`);

  const vaultState = deriveVaultStatePDA(programId);
  const treasuryAuthority = deriveTreasuryAuthorityPDA(programId);
  const treasuryTokenAccount = await getAssociatedTokenAddress(
    synMint,
    treasuryAuthority,
    true, // allowOwnerOffCurve — treasuryAuthority is a PDA
  );
  const ownerTokenAccount = await getAssociatedTokenAddress(synMint, owner);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_CU_PRICE_MICROLAMPORTS }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_LIMIT }),
  ];

  // Create the owner's SYN ATA when it doesn't exist yet — the program
  // transfers into it, so it must be initialised beforehand.
  const ownerAtaInfo = await connection.getAccountInfo(ownerTokenAccount);
  if (!ownerAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        owner, ownerTokenAccount, owner, synMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  // Account order taken from the `claim_rewards` IDL entry. Writable flags
  // match the IDL: vault_state, reward_account, owner, treasury_token_account,
  // owner_token_account are writable; treasury_authority + token_program are
  // read-only.
  instructions.push(new TransactionInstruction({
    programId,
    data: createClaimRewardsInstructionData(),
    keys: [
      { pubkey: vaultState,            isSigner: false, isWritable: true  },
      { pubkey: rewardAccount,         isSigner: false, isWritable: true  },
      { pubkey: owner,                 isSigner: true,  isWritable: true  },
      { pubkey: treasuryAuthority,     isSigner: false, isWritable: false },
      { pubkey: treasuryTokenAccount,  isSigner: false, isWritable: true  },
      { pubkey: ownerTokenAccount,     isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
    ],
  }));

  const tx = new Transaction().add(...instructions);
  return sendAndConfirmFresh(connection, tx, [wallet]);
}
