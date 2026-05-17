/**
 * Pure helpers for building the `syn_rewards_vault` on-chain instructions.
 *
 * Lives in its own module — separate from `rewards-vault-cli.ts` — so unit
 * tests can import it without dragging in `staking-cli` and its ESM-only
 * `@inquirer/prompts` transitive dep (which Jest's CJS path can't parse).
 *
 * Account ordering and discriminator MUST stay in sync with
 * `packages/contracts/programs/syn_rewards_vault/src/lib.rs`.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

export function deriveVaultStatePDA(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault_state')],
    programId,
  )[0];
}

export function derivePauseStatePDA(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pause_state')],
    programId,
  )[0];
}

export function deriveRewardAccountPDA(owner: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reward_account'), owner.toBuffer()],
    programId,
  )[0];
}

export function deriveTreasuryAuthorityPDA(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rewards_treasury')],
    programId,
  )[0];
}

export function createClaimRewardsInstructionData(): Buffer {
  // IDL discriminator for `claim_rewards` — no args.
  return Buffer.from([4, 144, 132, 71, 116, 23, 151, 80]);
}

/**
 * Build the raw `claim_rewards` instruction for the rewards vault program.
 *
 * Extracted as a pure helper so the account ordering — which previously
 * shipped with a missing slot and produced AccountDiscriminatorMismatch
 * (Anchor error 3002 / 0xbba) at runtime — can be unit-tested without
 * touching the wallet or RPC.
 *
 * Account order MUST match `ClaimRewards` in
 * `packages/contracts/programs/syn_rewards_vault/src/lib.rs` (8 accounts):
 *
 *   0. vault_state            (writable, PDA [b"vault_state"])
 *   1. pause_state            (read-only, PDA [b"pause_state"])
 *   2. reward_account         (writable, PDA [b"reward_account", owner])
 *   3. owner                  (signer,   writable)
 *   4. treasury_authority     (read-only, PDA [b"rewards_treasury"])
 *   5. treasury_token_account (writable)
 *   6. owner_token_account    (writable)
 *   7. token_program          (read-only, TOKEN_PROGRAM_ID)
 */
export function buildClaimRewardsInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  treasuryTokenAccount: PublicKey;
  ownerTokenAccount: PublicKey;
}): TransactionInstruction {
  const { programId, owner, treasuryTokenAccount, ownerTokenAccount } = args;
  const vaultState = deriveVaultStatePDA(programId);
  const pauseState = derivePauseStatePDA(programId);
  const rewardAccount = deriveRewardAccountPDA(owner, programId);
  const treasuryAuthority = deriveTreasuryAuthorityPDA(programId);

  return new TransactionInstruction({
    programId,
    data: createClaimRewardsInstructionData(),
    keys: [
      { pubkey: vaultState,            isSigner: false, isWritable: true  },
      { pubkey: pauseState,            isSigner: false, isWritable: false },
      { pubkey: rewardAccount,         isSigner: false, isWritable: true  },
      { pubkey: owner,                 isSigner: true,  isWritable: true  },
      { pubkey: treasuryAuthority,     isSigner: false, isWritable: false },
      { pubkey: treasuryTokenAccount,  isSigner: false, isWritable: true  },
      { pubkey: ownerTokenAccount,     isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
    ],
  });
}
