import { PublicKey } from '@solana/web3.js';
import {
  OFFICIAL_STAKING_PROGRAM_ID,
  OFFICIAL_SYN_TOKEN_PROGRAM_ID,
  OFFICIAL_ESCROW_PROGRAM_ID,
} from '../../constants/programs';

// The three env vars the idl.ts resolvers honour. The lazy PublicKey
// getters cache on first access and read `process.env` lazily, so each
// case must set env BEFORE importing the module and reset the module
// registry between cases to get a fresh cache.
const ENV_KEYS = ['STAKING_PROGRAM_ID', 'TOKEN_PROGRAM_ID', 'ESCROW_PROGRAM_ID'] as const;

// Real base58 pubkeys so the PublicKey proxies validate cleanly.
const OVERRIDE_STAKING = '11111111111111111111111111111111';
const OVERRIDE_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const OVERRIDE_ESCROW = 'Sysvar1nstructions1111111111111111111111111';

type IdlModule = typeof import('../idl');

async function loadIdl(): Promise<IdlModule> {
  let mod!: IdlModule;
  await jest.isolateModulesAsync(async () => {
    mod = await import('../idl');
  });
  return mod;
}

describe('utils/idl program id resolution', () => {
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

  it('resolves the OFFICIAL constants when NO env vars are set (no throw)', async () => {
    const idl = await loadIdl();

    // Reading the proxies must NOT throw "X not informed".
    expect(idl.STAKING_PROGRAM_ID.toBase58()).toBe(OFFICIAL_STAKING_PROGRAM_ID);
    // TOKEN_PROGRAM_ID resolves to the custom SYN token program (8iFr...),
    // NOT the standard SPL Token program.
    expect(idl.TOKEN_PROGRAM_ID.toBase58()).toBe(OFFICIAL_SYN_TOKEN_PROGRAM_ID);
    expect(idl.ESCROW_PROGRAM_ID.toBase58()).toBe(OFFICIAL_ESCROW_PROGRAM_ID);
  });

  it('pins the expected canonical addresses (CYW5 / 8iFr / HwFPR5)', async () => {
    const idl = await loadIdl();
    expect(idl.STAKING_PROGRAM_ID.toBase58()).toBe('CYW5Cprp5JuzaXtPyV8LPBgPzbze6QHnc3oFBAVaFkfw');
    expect(idl.TOKEN_PROGRAM_ID.toBase58()).toBe('8iFr3ciQuNeU4vkzQTp7NcWNgRr7AVhwyizNCAszaEQq');
    expect(idl.ESCROW_PROGRAM_ID.toBase58()).toBe('HwFPR5rGCkd7ak6SivRkaPnb5jzRMMHvC3wENK1mW2eK');
  });

  it('lets env vars override the OFFICIAL fallback', async () => {
    process.env.STAKING_PROGRAM_ID = OVERRIDE_STAKING;
    process.env.TOKEN_PROGRAM_ID = OVERRIDE_TOKEN;
    process.env.ESCROW_PROGRAM_ID = OVERRIDE_ESCROW;

    const idl = await loadIdl();

    expect(idl.STAKING_PROGRAM_ID.toBase58()).toBe(OVERRIDE_STAKING);
    expect(idl.TOKEN_PROGRAM_ID.toBase58()).toBe(OVERRIDE_TOKEN);
    expect(idl.ESCROW_PROGRAM_ID.toBase58()).toBe(OVERRIDE_ESCROW);
  });

  it('treats whitespace-only env values as unset (.trim() || OFFICIAL)', async () => {
    process.env.STAKING_PROGRAM_ID = '   ';
    process.env.TOKEN_PROGRAM_ID = '\t\n';
    process.env.ESCROW_PROGRAM_ID = '';

    const idl = await loadIdl();

    expect(idl.STAKING_PROGRAM_ID.toBase58()).toBe(OFFICIAL_STAKING_PROGRAM_ID);
    expect(idl.TOKEN_PROGRAM_ID.toBase58()).toBe(OFFICIAL_SYN_TOKEN_PROGRAM_ID);
    expect(idl.ESCROW_PROGRAM_ID.toBase58()).toBe(OFFICIAL_ESCROW_PROGRAM_ID);
  });

  it('derives PDAs against the OFFICIAL programs without env (no throw)', async () => {
    const idl = await loadIdl();

    // NOTE: idl is loaded in an isolated module registry, so its PublicKey
    // class identity differs from the top-level import — `toBeInstanceOf`
    // would cross realms. Assert the structural contract instead: derivation
    // does not throw and yields valid base58 keys.
    const [stake] = idl.deriveStakeAccount('peer-abc');
    const [mint] = idl.deriveTokenMint();
    const [escrow] = idl.deriveEscrowAccount('peer-abc');

    expect(typeof stake.toBase58()).toBe('string');
    expect(typeof mint.toBase58()).toBe('string');
    expect(typeof escrow.toBase58()).toBe('string');

    const all = idl.getAllProgramIds();
    expect(all.staking.toBase58()).toBe(OFFICIAL_STAKING_PROGRAM_ID);
    expect(all.token.toBase58()).toBe(OFFICIAL_SYN_TOKEN_PROGRAM_ID);
    expect(all.escrow.toBase58()).toBe(OFFICIAL_ESCROW_PROGRAM_ID);
  });
});
