/**
 * Integration tests for `claimStakingRewards` — proving the 3-way gate wires
 * through to the real tx-build/send path, NOT just the pure helper.
 *
 * The reviewer flagged that the unit tests only exercised
 * `computeLiveClaimableLamports` in isolation; nothing asserted that
 * `claimStakingRewards` actually PROCEEDS to `sendAndConfirmFresh` (vs the
 * early-return). These tests drive the full function with a mocked Solana
 * `Connection` + wallet, and assert on the network egress (`sendRawTransaction`)
 * to distinguish "proceeded" from "early-returned".
 *
 * Cases:
 *   1. raw==0 + pool read FAILS  → PROCEEDS (sendRawTransaction called).   [MEDIUM]
 *   2. raw==0 + pool read OK, last_accrual=0 (genuine 0) → EARLY-RETURN.
 *   3. live > 0                  → PROCEEDS (sendRawTransaction called).   [LOW]
 */

import {
  STAKE_OFF_AMOUNT,
  STAKE_OFF_REWARDS_PENDING,
  STAKE_OFF_LAST_ACCRUAL,
} from '../reward-estimate';

// ── Mock the wallet-unlock path so claimStakingRewards never touches a real
//    keystore / interactive prompt. We mock the keystore module + @inquirer
//    so `loadWalletWithPassword` resolves a real (valid ed25519) Keypair.
//    The secret key must be a genuine ed25519 secret or
//    `Keypair.fromSecretKey` rejects it ("provided secretKey is invalid").
jest.mock('@inquirer/prompts', () => ({
  password: jest.fn(async () => 'pw'),
  input: jest.fn(async () => ''),
}));

jest.mock('../../../infrastructure/keystore/passphrase-helpers', () => ({
  readPassphraseFromFile: jest.fn(async () => undefined),
  readPassphraseFromStdin: jest.fn(async () => undefined),
}));

jest.mock('../../../infrastructure/keystore/EncryptedKeystore', () => ({
  EncryptedKeystore: class {
    private readonly path: string;
    constructor(p: string) {
      this.path = p;
    }
    exists() {
      return true;
    }
    getPath() {
      return this.path;
    }
    async decrypt() {
      // Resolve a valid ed25519 secret key from the (partially mocked, but
      // Keypair-real) @solana/web3.js. Lazy-required because jest.mock
      // factories are hoisted above the top-level import.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Keypair: Kp } = require('@solana/web3.js');
      return Kp.generate().secretKey as Uint8Array;
    }
  },
  EncryptedKeystoreError: class extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

// ── Mock @solana/web3.js: keep everything real (PublicKey/Transaction/Keypair/
//    SystemProgram/ComputeBudgetProgram) EXCEPT `Connection`, which we replace
//    with a programmable double so we control account reads + capture sends.
class MockConnection {
  getAccountInfo: jest.Mock;
  getProgramAccounts: jest.Mock;
  getLatestBlockhash: jest.Mock;
  sendRawTransaction: jest.Mock;
  confirmTransaction: jest.Mock;

  constructor() {
    // `claimStakingRewards` builds its OWN `new Connection(...)` internally, so
    // each instance must wire itself from the shared scenario the test set.
    this.getAccountInfo = jest.fn(async (pk: { toBase58(): string }) => {
      const sc = currentScenario;
      if (!sc) return null;
      const b58 = pk.toBase58();
      if (b58 === sc.stakeAddrB58) return { data: sc.stakeData };
      if (b58 === sc.poolPdaB58) {
        if (sc.poolThrows) throw new Error('rpc boom');
        return sc.poolData === null ? null : { data: sc.poolData };
      }
      // Treasury ATA (and any other) → pretend it exists so no createATA path.
      return { data: Buffer.alloc(0) };
    });
    this.getProgramAccounts = jest.fn(async () => {
      const sc = currentScenario;
      return sc ? [{ pubkey: { toBase58: () => sc.stakeAddrB58 }, account: {} }] : [];
    });
    this.getLatestBlockhash = jest.fn(async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1,
    }));
    this.sendRawTransaction = jest.fn(async () => 'SIG_OK');
    this.confirmTransaction = jest.fn(async () => ({ value: { err: null } }));
    lastConnInstance = this;
  }
}

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return { ...actual, Connection: MockConnection };
});

import { claimStakingRewards } from '../staking-cli';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getStakingProgramId } from '../../../constants/programs';

const STAKE_LEN = 227;
const POOL_LEN = 200;
const POOL_OFF_DAILY = 8;
const POOL_OFF_TOTAL = 16;

interface Scenario {
  stakeAddrB58: string;
  poolPdaB58: string;
  stakeData: Buffer;
  poolData: Buffer | null;
  poolThrows: boolean;
}

// Shared across the production-built `new Connection(...)` and the test.
let currentScenario: Scenario | null = null;
let lastConnInstance: MockConnection | null = null;

function buildStakeBuffer(f: {
  amountLamports: bigint;
  rewardsPendingLamports: bigint;
  lastAccrualAt: bigint;
}): Buffer {
  const buf = Buffer.alloc(STAKE_LEN);
  buf.writeBigUInt64LE(f.amountLamports, STAKE_OFF_AMOUNT);
  buf.writeBigUInt64LE(f.rewardsPendingLamports, STAKE_OFF_REWARDS_PENDING);
  buf.writeBigInt64LE(f.lastAccrualAt, STAKE_OFF_LAST_ACCRUAL);
  return buf;
}

function buildPoolBuffer(daily: bigint, total: bigint): Buffer {
  const buf = Buffer.alloc(POOL_LEN);
  buf.writeBigUInt64LE(daily, POOL_OFF_DAILY);
  buf.writeBigUInt64LE(total, POOL_OFF_TOTAL);
  return buf;
}

/** Install the scenario the in-function `new Connection(...)` will read. */
function setScenario(opts: { stakeData: Buffer; poolData: Buffer | null; poolThrows?: boolean }) {
  const programId: PublicKey = getStakingProgramId();
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from('staking_pool')], programId);
  currentScenario = {
    stakeAddrB58: Keypair.generate().publicKey.toBase58(),
    poolPdaB58: poolPda.toBase58(),
    stakeData: opts.stakeData,
    poolData: opts.poolData,
    poolThrows: opts.poolThrows ?? false,
  };
}

describe('claimStakingRewards — 3-way gate integration (reaches tx send or early-returns)', () => {
  const FIXED_NOW_MS = 2_000_000_000_000;
  const nowSeconds = BigInt(Math.floor(FIXED_NOW_MS / 1000));
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    currentScenario = null;
    lastConnInstance = null;
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
    // claimStakingRewards reads the wallet via the mocked keystore; ensure no
    // forbidden env vars trip the warning path.
    delete process.env.SYNAPSEIA_WALLET_PASSWORD;
    delete process.env.WALLET_PASSWORD;
  });
  afterEach(() => nowSpy.mockRestore());

  it('case 1 (MEDIUM): raw==0 + pool read FAILS → PROCEEDS to sendRawTransaction', async () => {
    setScenario({
      stakeData: buildStakeBuffer({
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: 0n, // raw also 0
        lastAccrualAt: nowSeconds - 3_600n,
      }),
      poolData: null,
      poolThrows: true, // estimate fails → estimateOk=false → must NOT block
    });

    const sig = await claimStakingRewards();

    expect(lastConnInstance!.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(sig).toBe('SIG_OK');
  });

  it('case 2: raw==0 + pool OK + last_accrual=0 (genuine 0) → EARLY-RETURN, no tx', async () => {
    setScenario({
      stakeData: buildStakeBuffer({
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: 0n,
        lastAccrualAt: 0n, // never accrued → live 0, estimateOk=true → block
      }),
      poolData: buildPoolBuffer(50_000_000_000n, 4_000_000_000_000n),
    });

    const sig = await claimStakingRewards();

    expect(lastConnInstance!.sendRawTransaction).not.toHaveBeenCalled();
    expect(sig).toBe('');
  });

  it('case 3 (LOW): live > 0 → PROCEEDS to sendRawTransaction', async () => {
    setScenario({
      stakeData: buildStakeBuffer({
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: 5_000_000_000_000n, // ~5000 SYN in raw field
        lastAccrualAt: nowSeconds - 3_600n,
      }),
      poolData: buildPoolBuffer(50_000_000_000n, 4_000_000_000_000n),
    });

    const sig = await claimStakingRewards();

    expect(lastConnInstance!.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(sig).toBe('SIG_OK');
  });
});
