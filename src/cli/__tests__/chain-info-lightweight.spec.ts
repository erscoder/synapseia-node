/**
 * Unit tests for the live-accrual estimation added to `fetchStakeInfo`
 * in chain-info-lightweight.ts.
 *
 * The bug: the CLI returned the RAW on-chain `rewards_pending` field, which
 * lags real time (hourly cron accrue). node-ui therefore showed "0 SYN" and
 * disabled Claim even with thousands of SYN actually claimable. The fix makes
 * `rewardsPending` the LIVE claimable amount = raw field + estimated accrual
 * since `last_accrual_at`, replicating the on-chain `get_rewards` view +
 * `calc_rewards` (syn_staking lib.rs:565 / :1392) EXACTLY.
 *
 * We exercise the real `fetchStakeInfo` via the exported `connFactory` seam,
 * feeding it raw byte buffers (real `Buffer`s with the exact V3 StakeAccount
 * + StakingPool offsets) through a mock Connection. The pure formula helper
 * `estimateLiveRewardsLamports` is also asserted directly so the expected
 * value is DERIVED from the documented formula, never copied from impl.
 */

import {
  estimateLiveRewardsLamports,
  __testing,
} from '../chain-info-lightweight';

// SECONDS_PER_DAY verbatim from syn_staking/src/lib.rs:13.
const SECONDS_PER_DAY = 86_400n;

// ── StakeAccount byte offsets (absolute, into account.data) ──
const OFF_AMOUNT = 72;
const OFF_LOCKED_UNTIL = 162;
const OFF_REWARDS_PENDING = 170;
const OFF_LAST_ACCRUAL = 186;
const STAKE_LEN = 227; // V3 size (8 disc + 219 payload)

// ── StakingPool byte offsets (absolute, after 8-byte disc) ──
const OFF_DAILY_POOL = 8;
const OFF_TOTAL_STAKED = 16;
const POOL_LEN = 200; // anything >= 24 works; use a realistic size

interface StakeFields {
  amountLamports: bigint;
  lockedUntil: bigint;
  rewardsPendingLamports: bigint;
  lastAccrualAt: bigint;
}

function buildStakeBuffer(f: StakeFields, len = STAKE_LEN): Buffer {
  const buf = Buffer.alloc(len);
  // Only write fields that fit — a pre-upgrade short buffer simply lacks the
  // tail fields, mirroring the real "stale layout" scenario the length guard
  // protects against.
  if (len >= OFF_AMOUNT + 8) buf.writeBigUInt64LE(f.amountLamports, OFF_AMOUNT);
  if (len >= OFF_LOCKED_UNTIL + 8) buf.writeBigInt64LE(f.lockedUntil, OFF_LOCKED_UNTIL);
  if (len >= OFF_REWARDS_PENDING + 8) buf.writeBigUInt64LE(f.rewardsPendingLamports, OFF_REWARDS_PENDING);
  if (len >= OFF_LAST_ACCRUAL + 8) buf.writeBigInt64LE(f.lastAccrualAt, OFF_LAST_ACCRUAL);
  return buf;
}

function buildPoolBuffer(dailyPoolLamports: bigint, totalStakedLamports: bigint, len = POOL_LEN): Buffer {
  const buf = Buffer.alloc(len);
  buf.writeBigUInt64LE(dailyPoolLamports, OFF_DAILY_POOL);
  buf.writeBigUInt64LE(totalStakedLamports, OFF_TOTAL_STAKED);
  return buf;
}

/**
 * Build a mock connection factory that returns the given stake account from
 * getProgramAccounts and the given pool buffer (or null) from getAccountInfo.
 */
function mockConnFactory(opts: {
  stakeData: Buffer | null;
  poolData: Buffer | null;
  poolThrows?: boolean;
}) {
  return async () => ({
    getProgramAccounts: jest.fn(async () =>
      opts.stakeData === null ? [] : [{ account: { data: opts.stakeData } }],
    ),
    getAccountInfo: jest.fn(async () => {
      if (opts.poolThrows) throw new Error('rpc boom');
      return opts.poolData === null ? null : { data: opts.poolData };
    }),
  });
}

const PROGRAM_ID = 'Stake11111111111111111111111111111111111111';
const OWNER = 'So11111111111111111111111111111111111111112';
const RPC = 'http://localhost:8899';

/** UI-unit rounding tolerance for floating compare after the /1e9 step. */
const EPS = 1e-12;

describe('estimateLiveRewardsLamports (pure get_rewards replica)', () => {
  it('(a) field=0 + nonzero stake + last_accrual in the past → equals calc_rewards derived independently', () => {
    const staked = 1_000_000_000_000n; // 1000 SYN
    const dailyPool = 50_000_000_000n; // 50 SYN/day pool
    const totalStaked = 4_000_000_000_000n; // 4000 SYN
    const nowSeconds = 2_000_000_000n;
    const lastAccrual = nowSeconds - 3_600n; // 1 hour ago
    const elapsed = nowSeconds - lastAccrual; // 3600

    // Derived from the documented formula — NOT copied from impl.
    const expected = (staked * dailyPool * elapsed) / totalStaked / SECONDS_PER_DAY;

    const got = estimateLiveRewardsLamports({
      rewardsPendingLamports: 0n,
      stakedLamports: staked,
      lastAccrualAt: lastAccrual,
      nowSeconds,
      dailyPoolLamports: dailyPool,
      totalStakedLamports: totalStaked,
    });
    expect(got).toBe(expected);
    expect(got).toBeGreaterThan(0n);
  });

  it('adds the raw rewards_pending field on top of the estimate', () => {
    const staked = 1_000_000_000_000n;
    const dailyPool = 50_000_000_000n;
    const totalStaked = 4_000_000_000_000n;
    const nowSeconds = 2_000_000_000n;
    const lastAccrual = nowSeconds - 3_600n;
    const elapsed = 3_600n;
    const field = 5_096_000_000_000n; // ~5096 SYN already accrued

    const expected = field + (staked * dailyPool * elapsed) / totalStaked / SECONDS_PER_DAY;
    const got = estimateLiveRewardsLamports({
      rewardsPendingLamports: field,
      stakedLamports: staked,
      lastAccrualAt: lastAccrual,
      nowSeconds,
      dailyPoolLamports: dailyPool,
      totalStakedLamports: totalStaked,
    });
    expect(got).toBe(expected);
  });

  it('(b) last_accrual_at=0 → estimated 0 (returns just the field)', () => {
    const field = 123_456_789n;
    const got = estimateLiveRewardsLamports({
      rewardsPendingLamports: field,
      stakedLamports: 1_000_000_000_000n,
      lastAccrualAt: 0n,
      nowSeconds: 2_000_000_000n,
      dailyPoolLamports: 50_000_000_000n,
      totalStakedLamports: 4_000_000_000_000n,
    });
    expect(got).toBe(field);
  });

  it('(c) total_staked=0 → estimated 0 (mirrors calc_rewards zero-guard)', () => {
    const field = 42n;
    const got = estimateLiveRewardsLamports({
      rewardsPendingLamports: field,
      stakedLamports: 1_000_000_000_000n,
      lastAccrualAt: 1_000n,
      nowSeconds: 2_000_000_000n,
      dailyPoolLamports: 50_000_000_000n,
      totalStakedLamports: 0n,
    });
    expect(got).toBe(field);
  });

  it('staked=0, daily_pool=0, or now < last_accrual → estimated 0', () => {
    const base = {
      rewardsPendingLamports: 7n,
      lastAccrualAt: 1_000n,
      nowSeconds: 2_000_000_000n,
      dailyPoolLamports: 50_000_000_000n,
      totalStakedLamports: 4_000_000_000_000n,
      stakedLamports: 1_000_000_000_000n,
    };
    expect(estimateLiveRewardsLamports({ ...base, stakedLamports: 0n })).toBe(7n);
    expect(estimateLiveRewardsLamports({ ...base, dailyPoolLamports: 0n })).toBe(7n);
    // now < last_accrual → elapsed clamps to 0 → estimated 0
    expect(estimateLiveRewardsLamports({ ...base, nowSeconds: 500n })).toBe(7n);
  });

  it('(e) BigInt precision: 28_263_789_000_000 * daily_pool * elapsed exceeds 2^53 — Number would lose precision, BigInt does not', () => {
    const staked = 28_263_789_000_000n; // ~28263 SYN
    const dailyPool = 1_000_000_000_000n; // 1000 SYN/day
    const totalStaked = 100_000_000_000_000n; // 100k SYN
    const nowSeconds = 2_000_000_000n;
    const lastAccrual = nowSeconds - 46_800n; // ~13h lag, the real scenario
    const elapsed = 46_800n;

    const numerator = staked * dailyPool * elapsed;
    // Prove the numerator overflows the IEEE-754 safe integer range, so the
    // multiply-then-divide MUST be done in BigInt to be exact.
    expect(numerator).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const expected = numerator / totalStaked / SECONDS_PER_DAY;
    const got = estimateLiveRewardsLamports({
      rewardsPendingLamports: 0n,
      stakedLamports: staked,
      lastAccrualAt: lastAccrual,
      nowSeconds,
      dailyPoolLamports: dailyPool,
      totalStakedLamports: totalStaked,
    });
    expect(got).toBe(expected);

    // Sanity: doing the same multiply in Number drifts from the BigInt result.
    const naiveNumber = Number(staked) * Number(dailyPool) * Number(elapsed);
    expect(BigInt(Math.trunc(naiveNumber))).not.toBe(numerator);
  });
});

describe('fetchStakeInfo (live-accrued rewardsPending end-to-end)', () => {
  // now is read via Date.now() inside fetchStakeInfo; pin it.
  const FIXED_NOW_MS = 2_000_000_000_000; // → 2_000_000_000 unix seconds
  let nowSpy: jest.SpyInstance;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
  });
  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('(a) returns field + live accrual when field=0 and pool reads succeed', async () => {
    const staked = 1_000_000_000_000n;
    const dailyPool = 50_000_000_000n;
    const totalStaked = 4_000_000_000_000n;
    const nowSeconds = BigInt(Math.floor(FIXED_NOW_MS / 1000));
    const lastAccrual = nowSeconds - 3_600n;
    const elapsed = 3_600n;

    const stakeData = buildStakeBuffer({
      amountLamports: staked,
      lockedUntil: 0n,
      rewardsPendingLamports: 0n,
      lastAccrualAt: lastAccrual,
    });
    const poolData = buildPoolBuffer(dailyPool, totalStaked);

    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData, poolData }),
    );

    const expectedLamports = (staked * dailyPool * elapsed) / totalStaked / SECONDS_PER_DAY;
    expect(info.exists).toBe(true);
    expect(info.amount).toBeCloseTo(Number(staked) / 1e9, 9);
    expect(info.rewardsPending).toBeCloseTo(Number(expectedLamports) / 1e9, 9);
    expect(info.rewardsPending).toBeGreaterThan(0);
  });

  it('(b) last_accrual_at=0 → estimate 0, rewardsPending equals raw field only', async () => {
    const field = 5_096_000_000_000n; // 5096 SYN
    const stakeData = buildStakeBuffer({
      amountLamports: 1_000_000_000_000n,
      lockedUntil: 0n,
      rewardsPendingLamports: field,
      lastAccrualAt: 0n,
    });
    const poolData = buildPoolBuffer(50_000_000_000n, 4_000_000_000_000n);

    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData, poolData }),
    );
    expect(info.rewardsPending).toBeCloseTo(Number(field) / 1e9, 9);
  });

  it('(c) total_staked=0 in pool → estimate 0, rewardsPending equals raw field only', async () => {
    const field = 1_000_000_000n; // 1 SYN
    const nowSeconds = BigInt(Math.floor(FIXED_NOW_MS / 1000));
    const stakeData = buildStakeBuffer({
      amountLamports: 1_000_000_000_000n,
      lockedUntil: 0n,
      rewardsPendingLamports: field,
      lastAccrualAt: nowSeconds - 3_600n,
    });
    const poolData = buildPoolBuffer(50_000_000_000n, 0n); // total_staked = 0

    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData, poolData }),
    );
    expect(info.rewardsPending).toBeCloseTo(Number(field) / 1e9, 9);
  });

  it('(d) pool account missing → falls back to raw field, no throw', async () => {
    const field = 5_096_000_000_000n;
    const nowSeconds = BigInt(Math.floor(FIXED_NOW_MS / 1000));
    const stakeData = buildStakeBuffer({
      amountLamports: 1_000_000_000_000n,
      lockedUntil: 0n,
      rewardsPendingLamports: field,
      lastAccrualAt: nowSeconds - 3_600n,
    });

    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData, poolData: null }),
    );
    expect(info.exists).toBe(true);
    expect(info.rewardsPending).toBeCloseTo(Number(field) / 1e9, 9);
  });

  it('(d) pool read throws → falls back to raw field, no throw', async () => {
    const field = 2_500_000_000_000n;
    const nowSeconds = BigInt(Math.floor(FIXED_NOW_MS / 1000));
    const stakeData = buildStakeBuffer({
      amountLamports: 1_000_000_000_000n,
      lockedUntil: 0n,
      rewardsPendingLamports: field,
      lastAccrualAt: nowSeconds - 3_600n,
    });

    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData, poolData: null, poolThrows: true }),
    );
    expect(info.exists).toBe(true);
    expect(info.rewardsPending).toBeCloseTo(Number(field) / 1e9, 9);
  });

  it('pool too short (< 24 bytes) → falls back to raw field', async () => {
    const field = 999_000_000_000n;
    const nowSeconds = BigInt(Math.floor(FIXED_NOW_MS / 1000));
    const stakeData = buildStakeBuffer({
      amountLamports: 1_000_000_000_000n,
      lockedUntil: 0n,
      rewardsPendingLamports: field,
      lastAccrualAt: nowSeconds - 3_600n,
    });
    const shortPool = Buffer.alloc(16); // < 24 → skip estimation

    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData, poolData: shortPool }),
    );
    expect(info.rewardsPending).toBeCloseTo(Number(field) / 1e9, 9);
  });

  it('no stake account → exists:false, all zeros', async () => {
    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData: null, poolData: null }),
    );
    expect(info).toEqual({ exists: false, amount: 0, rewardsPending: 0, lockedUntil: 0 });
  });

  it('stake buffer too short (< 194 bytes) → exists:false (no garbage read)', async () => {
    const shortStake = buildStakeBuffer(
      {
        amountLamports: 1_000_000_000_000n,
        lockedUntil: 0n,
        rewardsPendingLamports: 1n,
        lastAccrualAt: 1n,
      },
      180,
    );
    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData: shortStake, poolData: buildPoolBuffer(1n, 1n) }),
    );
    expect(info.exists).toBe(false);
  });

  it('keeps lockedUntil from offset 162', async () => {
    const lockedUntil = 1_900_000_000n;
    const stakeData = buildStakeBuffer({
      amountLamports: 1_000_000_000_000n,
      lockedUntil,
      rewardsPendingLamports: 0n,
      lastAccrualAt: 0n,
    });
    const info = await __testing.fetchStakeInfo(
      RPC,
      OWNER,
      PROGRAM_ID,
      mockConnFactory({ stakeData, poolData: buildPoolBuffer(1n, 1n) }),
    );
    expect(info.lockedUntil).toBe(Number(lockedUntil));
  });

  // Use EPS to silence unused-var lint in environments that flag it.
  it('sanity: EPS constant is positive', () => {
    expect(EPS).toBeGreaterThan(0);
  });
});
