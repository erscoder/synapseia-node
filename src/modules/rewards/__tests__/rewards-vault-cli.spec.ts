/**
 * Regression guard for the `claim_rewards` instruction account ordering.
 *
 * Background: the CLI shipped a 7-account ClaimRewards instruction while
 * the on-chain `syn_rewards_vault` program declares 8 accounts (slot 1 =
 * pause_state). Anchor mapped reward_account into the pause_state slot
 * and rejected with AccountDiscriminatorMismatch (error 3002 / 0xbba).
 *
 * The contract source of truth is
 *   packages/contracts/programs/syn_rewards_vault/src/lib.rs (ClaimRewards).
 * Slots:
 *   0 vault_state            (writable)
 *   1 pause_state            (read-only)
 *   2 reward_account         (writable)
 *   3 owner                  (signer, writable)
 *   4 treasury_authority     (read-only)
 *   5 treasury_token_account (writable)
 *   6 owner_token_account    (writable)
 *   7 token_program          (read-only, TOKEN_PROGRAM_ID)
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  buildClaimRewardsInstruction,
  createClaimRewardsInstructionData,
  derivePauseStatePDA,
  deriveRewardAccountPDA,
  deriveTreasuryAuthorityPDA,
  deriveVaultStatePDA,
} from '../rewards-vault-instruction';
import { getRewardsVaultProgramId } from '../../../constants/programs';

describe('buildClaimRewardsInstruction', () => {
  const programId = getRewardsVaultProgramId();
  const owner = Keypair.generate().publicKey;
  const treasuryTokenAccount = Keypair.generate().publicKey;
  const ownerTokenAccount = Keypair.generate().publicKey;

  const ix = buildClaimRewardsInstruction({
    programId,
    owner,
    treasuryTokenAccount,
    ownerTokenAccount,
  });

  it('targets the rewards vault program', () => {
    expect(ix.programId.equals(programId)).toBe(true);
  });

  it('encodes the IDL discriminator with no args', () => {
    expect(Buffer.from(ix.data).equals(createClaimRewardsInstructionData())).toBe(true);
    expect(ix.data.length).toBe(8);
  });

  it('serialises exactly 8 accounts (contract requires 8, not 7)', () => {
    expect(ix.keys.length).toBe(8);
  });

  it('places vault_state at slot 0 (writable)', () => {
    const expected = deriveVaultStatePDA(programId);
    expect(ix.keys[0].pubkey.equals(expected)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    expect(ix.keys[0].isWritable).toBe(true);
  });

  it('places pause_state at slot 1 (read-only, non-signer) — the slot that was missing', () => {
    const expected = derivePauseStatePDA(programId);
    expect(ix.keys[1].pubkey.equals(expected)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(false);
    expect(ix.keys[1].isWritable).toBe(false);
  });

  it('places reward_account at slot 2 (writable) — NOT slot 1 where it used to sit', () => {
    const expected = deriveRewardAccountPDA(owner, programId);
    expect(ix.keys[2].pubkey.equals(expected)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(false);
    expect(ix.keys[2].isWritable).toBe(true);
  });

  it('places owner at slot 3 (signer + writable)', () => {
    expect(ix.keys[3].pubkey.equals(owner)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
  });

  it('places treasury_authority at slot 4 (read-only PDA)', () => {
    const expected = deriveTreasuryAuthorityPDA(programId);
    expect(ix.keys[4].pubkey.equals(expected)).toBe(true);
    expect(ix.keys[4].isSigner).toBe(false);
    expect(ix.keys[4].isWritable).toBe(false);
  });

  it('places treasury_token_account at slot 5 (writable)', () => {
    expect(ix.keys[5].pubkey.equals(treasuryTokenAccount)).toBe(true);
    expect(ix.keys[5].isWritable).toBe(true);
  });

  it('places owner_token_account at slot 6 (writable)', () => {
    expect(ix.keys[6].pubkey.equals(ownerTokenAccount)).toBe(true);
    expect(ix.keys[6].isWritable).toBe(true);
  });

  it('places TOKEN_PROGRAM_ID at slot 7 (read-only) — regression guard for trailing slot', () => {
    expect(ix.keys[7].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[7].isSigner).toBe(false);
    expect(ix.keys[7].isWritable).toBe(false);
  });
});

describe('derivePauseStatePDA', () => {
  it('uses seed "pause_state" — matches the contract InitializePauseState seeds', () => {
    const programId = getRewardsVaultProgramId();
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from('pause_state')],
      programId,
    )[0];
    expect(derivePauseStatePDA(programId).equals(expected)).toBe(true);
  });
});
