import { PublicKey } from '@solana/web3.js';
import {
  OFFICIAL_STAKING_PROGRAM_ID,
  OFFICIAL_REWARDS_VAULT_PROGRAM_ID,
  OFFICIAL_ESCROW_PROGRAM_ID,
  OFFICIAL_SYN_TOKEN_PROGRAM_ID,
  OFFICIAL_SYN_TOKEN_MINT,
  getStakingProgramIdString,
  getRewardsVaultProgramIdString,
  getEscrowProgramIdString,
  getSynTokenProgramIdString,
  getSynTokenMintString,
  getStakingProgramId,
  getRewardsVaultProgramId,
  getEscrowProgramId,
  getSynTokenProgramId,
  getSynTokenMint,
} from '../programs';

// The five env vars the resolvers honour. Saved + restored per-test so
// the suite doesn't leak state to siblings that read `process.env`.
const ENV_KEYS = [
  'STAKING_PROGRAM_ID',
  'REWARDS_VAULT_PROGRAM_ID',
  'ESCROW_PROGRAM_ID',
  'SYN_TOKEN_PROGRAM_ID',
  'SYN_TOKEN_MINT',
] as const;

describe('constants/programs', () => {
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = originalEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('exposes the canonical devnet addresses as OFFICIAL_* constants', () => {
    expect(OFFICIAL_STAKING_PROGRAM_ID).toBe(
      'CYW5Cprp5JuzaXtPyV8LPBgPzbze6QHnc3oFBAVaFkfw',
    );
    expect(OFFICIAL_REWARDS_VAULT_PROGRAM_ID).toBe(
      'D9pkzWv2Ak9J8vXDVcMM1P51hDmjRJEwbuYHxCuJKTEN',
    );
    expect(OFFICIAL_ESCROW_PROGRAM_ID).toBe(
      'HwFPR5rGCkd7ak6SivRkaPnb5jzRMMHvC3wENK1mW2eK',
    );
    expect(OFFICIAL_SYN_TOKEN_PROGRAM_ID).toBe(
      '8iFr3ciQuNeU4vkzQTp7NcWNgRr7AVhwyizNCAszaEQq',
    );
    // SYN_TOKEN_MINT is the mint account, NOT the syn_token program id.
    expect(OFFICIAL_SYN_TOKEN_MINT).toBe(
      'DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8',
    );
    expect(OFFICIAL_SYN_TOKEN_MINT).not.toBe(OFFICIAL_SYN_TOKEN_PROGRAM_ID);
  });

  it('falls back to the canonical default when env is unset', () => {
    expect(getStakingProgramIdString()).toBe(OFFICIAL_STAKING_PROGRAM_ID);
    expect(getRewardsVaultProgramIdString()).toBe(OFFICIAL_REWARDS_VAULT_PROGRAM_ID);
    expect(getEscrowProgramIdString()).toBe(OFFICIAL_ESCROW_PROGRAM_ID);
    expect(getSynTokenProgramIdString()).toBe(OFFICIAL_SYN_TOKEN_PROGRAM_ID);
    expect(getSynTokenMintString()).toBe(OFFICIAL_SYN_TOKEN_MINT);
  });

  it('honours env overrides when set', () => {
    // Real base58 pubkeys (32 zero bytes / system program) so the
    // PublicKey wrappers below also validate cleanly.
    const overrideA = '11111111111111111111111111111111';
    const overrideB = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    process.env.STAKING_PROGRAM_ID = overrideA;
    process.env.REWARDS_VAULT_PROGRAM_ID = overrideA;
    process.env.ESCROW_PROGRAM_ID = overrideA;
    process.env.SYN_TOKEN_PROGRAM_ID = overrideB;
    process.env.SYN_TOKEN_MINT = overrideB;

    expect(getStakingProgramIdString()).toBe(overrideA);
    expect(getRewardsVaultProgramIdString()).toBe(overrideA);
    expect(getEscrowProgramIdString()).toBe(overrideA);
    expect(getSynTokenProgramIdString()).toBe(overrideB);
    expect(getSynTokenMintString()).toBe(overrideB);
  });

  it('treats whitespace-only env values as unset (.trim() || default)', () => {
    process.env.STAKING_PROGRAM_ID = '   ';
    process.env.REWARDS_VAULT_PROGRAM_ID = '\t\n';
    process.env.ESCROW_PROGRAM_ID = '';
    process.env.SYN_TOKEN_PROGRAM_ID = '  \n  ';
    process.env.SYN_TOKEN_MINT = ' ';

    expect(getStakingProgramIdString()).toBe(OFFICIAL_STAKING_PROGRAM_ID);
    expect(getRewardsVaultProgramIdString()).toBe(OFFICIAL_REWARDS_VAULT_PROGRAM_ID);
    expect(getEscrowProgramIdString()).toBe(OFFICIAL_ESCROW_PROGRAM_ID);
    expect(getSynTokenProgramIdString()).toBe(OFFICIAL_SYN_TOKEN_PROGRAM_ID);
    expect(getSynTokenMintString()).toBe(OFFICIAL_SYN_TOKEN_MINT);
  });

  it('PublicKey getters return valid PublicKey instances matching the string getters', () => {
    const pairs: Array<[() => PublicKey, () => string]> = [
      [getStakingProgramId, getStakingProgramIdString],
      [getRewardsVaultProgramId, getRewardsVaultProgramIdString],
      [getEscrowProgramId, getEscrowProgramIdString],
      [getSynTokenProgramId, getSynTokenProgramIdString],
      [getSynTokenMint, getSynTokenMintString],
    ];
    for (const [pk, str] of pairs) {
      const key = pk();
      expect(key).toBeInstanceOf(PublicKey);
      expect(key.toBase58()).toBe(str());
    }
  });
});
