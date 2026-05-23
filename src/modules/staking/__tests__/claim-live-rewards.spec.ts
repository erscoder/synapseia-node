/**
 * Unit tests for the LIVE-rewards pre-check that gates `claimStakingRewards`.
 *
 * The bug: `claimStakingRewards` read the RAW on-chain `StakeAccount.
 * rewards_pending` field (offset 170) and early-returned "No pending rewards"
 * when it was 0. That field lags real time (~13h, hourly accrue cron), so the
 * claim did NOTHING even when node-ui showed thousands of SYN claimable. The
 * on-chain `claim_rewards` ix self-accrues `now - last_accrual_at` before
 * sweeping, so the LIVE estimate (raw field + accrued-since-last_accrual) is
 * the correct gate.
 *
 * MEDIUM follow-up: when the staking_pool read / estimate FAILS and the raw
 * `rewards_pending` field is also 0, the old code returned 0n and the gate
 * BLOCKED the claim — even though the wallet may hold live-but-unaccrued
 * rewards the on-chain ix would self-accrue and pay. `computeLiveClaimableLamports`
 * now returns a discriminated `{ lamports, estimateOk }`: `estimateOk=false`
 * means "pool read/estimate failed, value is a raw-field fallback only", so the
 * caller must PROCEED on a 0 (let the ix decide, it fails closed harmlessly).
 *
 * `computeLiveClaimableLamports` is the extracted decision unit; we assert its
 * `.lamports` against the formula DERIVED independently here — never a magic
 * number copied from the impl — and its `.estimateOk` flag per branch.
 */

import {
  computeLiveClaimableLamports,
  estimateLiveRewardsLamports,
  SECONDS_PER_DAY,
  STAKE_OFF_AMOUNT,
  STAKE_OFF_REWARDS_PENDING,
  STAKE_OFF_LAST_ACCRUAL,
} from '../reward-estimate';

// ── StakingPool offsets (absolute, after the 8-byte discriminator) ──
const OFF_DAILY_POOL = 8;
const OFF_TOTAL_STAKED = 16;
const STAKE_LEN = 227; // V3 size (8 disc + 219 payload)
const POOL_LEN = 200;

interface StakeFields {
  amountLamports: bigint;
  rewardsPendingLamports: bigint;
  lastAccrualAt: bigint;
}

function buildStakeBuffer(f: StakeFields, len = STAKE_LEN): Buffer {
  const buf = Buffer.alloc(len);
  if (len >= STAKE_OFF_AMOUNT + 8) buf.writeBigUInt64LE(f.amountLamports, STAKE_OFF_AMOUNT);
  if (len >= STAKE_OFF_REWARDS_PENDING + 8)
    buf.writeBigUInt64LE(f.rewardsPendingLamports, STAKE_OFF_REWARDS_PENDING);
  if (len >= STAKE_OFF_LAST_ACCRUAL + 8)
    buf.writeBigInt64LE(f.lastAccrualAt, STAKE_OFF_LAST_ACCRUAL);
  return buf;
}

function buildPoolBuffer(dailyPoolLamports: bigint, totalStakedLamports: bigint, len = POOL_LEN): Buffer {
  const buf = Buffer.alloc(len);
  buf.writeBigUInt64LE(dailyPoolLamports, OFF_DAILY_POOL);
  buf.writeBigUInt64LE(totalStakedLamports, OFF_TOTAL_STAKED);
  return buf;
}

/** Structural mock of the `connection.getAccountInfo(stakingPool)` call. */
function mockConn(opts: { poolData: Buffer | null; throws?: boolean }) {
  const getAccountInfo = jest.fn(async () => {
    if (opts.throws) throw new Error('rpc boom');
    return opts.poolData === null ? null : ({ data: opts.poolData } as { data: Buffer });
  });
  return { getAccountInfo } as unknown as Parameters<typeof computeLiveClaimableLamports>[0];
}

// `stakingPool` PDA address is opaque to the helper (only passed to the mock).
const FAKE_POOL = { toBase58: () => 'pool' } as unknown as Parameters<
  typeof computeLiveClaimableLamports
>[2];

describe('computeLiveClaimableLamports — claim pre-check gate', () => {
  const FIXED_NOW_MS = 2_000_000_000_000; // → 2_000_000_000 unix seconds
  const nowSeconds = BigInt(Math.floor(FIXED_NOW_MS / 1000));
  let nowSpy: jest.SpyInstance;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
  });
  afterEach(() => nowSpy.mockRestore());

  it('(a) raw field 0 + nonzero stake + last_accrual in the past + pool params → live > 0 → claim PROCEEDS', async () => {
    const staked = 1_000_000_000_000n; // 1000 SYN
    const dailyPool = 50_000_000_000n; // 50 SYN/day pool
    const totalStaked = 4_000_000_000_000n; // 4000 SYN
    const lastAccrual = nowSeconds - 3_600n; // 1h ago
    const elapsed = 3_600n;

    const stakeData = buildStakeBuffer({
      amountLamports: staked,
      rewardsPendingLamports: 0n, // STALE raw field — the bug's trigger
      lastAccrualAt: lastAccrual,
    });
    const conn = mockConn({ poolData: buildPoolBuffer(dailyPool, totalStaked) });

    const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);

    // Expected DERIVED independently from the documented formula.
    const expected = (staked * dailyPool * elapsed) / totalStaked / SECONDS_PER_DAY;
    expect(live).toBe(expected);
    expect(estimateOk).toBe(true); // live math ran end-to-end
    // The gate in claimStakingRewards proceeds iff live > 0 (Number/1e9 > 0).
    expect(live).toBeGreaterThan(0n);
    expect(Number(live) / 1e9).toBeGreaterThan(0);
  });

  it('(b) raw field 0 + last_accrual_at=0 → live 0 → claim EARLY-RETURNS', async () => {
    const stakeData = buildStakeBuffer({
      amountLamports: 1_000_000_000_000n,
      rewardsPendingLamports: 0n,
      lastAccrualAt: 0n, // never accrued → estimate 0
    });
    const conn = mockConn({ poolData: buildPoolBuffer(50_000_000_000n, 4_000_000_000_000n) });

    const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
    expect(live).toBe(0n);
    // GENUINE zero: pool read succeeded, math ran → estimateOk → claim blocks.
    expect(estimateOk).toBe(true);
  });

  it('(b) raw field 0 + zero stake → live 0 → claim EARLY-RETURNS', async () => {
    const stakeData = buildStakeBuffer({
      amountLamports: 0n, // nothing staked → calc_rewards zero-guard
      rewardsPendingLamports: 0n,
      lastAccrualAt: nowSeconds - 3_600n,
    });
    const conn = mockConn({ poolData: buildPoolBuffer(50_000_000_000n, 4_000_000_000_000n) });

    const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
    expect(live).toBe(0n);
    expect(estimateOk).toBe(true); // genuine zero
  });

  it('adds the raw rewards_pending field on top of the live estimate', async () => {
    const staked = 1_000_000_000_000n;
    const dailyPool = 50_000_000_000n;
    const totalStaked = 4_000_000_000_000n;
    const lastAccrual = nowSeconds - 3_600n;
    const elapsed = 3_600n;
    const field = 5_096_000_000_000n; // ~5096 SYN already in the raw field

    const stakeData = buildStakeBuffer({
      amountLamports: staked,
      rewardsPendingLamports: field,
      lastAccrualAt: lastAccrual,
    });
    const conn = mockConn({ poolData: buildPoolBuffer(dailyPool, totalStaked) });

    const { lamports: live } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
    const expected = field + (staked * dailyPool * elapsed) / totalStaked / SECONDS_PER_DAY;
    expect(live).toBe(expected);
    // Matches the canonical pure helper exactly (single-source check, P34).
    expect(live).toBe(
      estimateLiveRewardsLamports({
        rewardsPendingLamports: field,
        stakedLamports: staked,
        lastAccrualAt: lastAccrual,
        nowSeconds,
        dailyPoolLamports: dailyPool,
        totalStakedLamports: totalStaked,
      }),
    );
  });

  it('(c) BigInt precision: 28e12 * pool * elapsed exceeds 2^53 — no precision loss', async () => {
    const staked = 28_263_789_000_000n; // ~28263 SYN
    const dailyPool = 1_000_000_000_000n; // 1000 SYN/day
    const totalStaked = 100_000_000_000_000n; // 100k SYN
    const lastAccrual = nowSeconds - 46_800n; // ~13h lag, the real scenario
    const elapsed = 46_800n;

    const numerator = staked * dailyPool * elapsed;
    // Prove the numerator overflows IEEE-754 safe-integer range.
    expect(numerator).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const stakeData = buildStakeBuffer({
      amountLamports: staked,
      rewardsPendingLamports: 0n,
      lastAccrualAt: lastAccrual,
    });
    const conn = mockConn({ poolData: buildPoolBuffer(dailyPool, totalStaked) });

    const { lamports: live } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
    const expected = numerator / totalStaked / SECONDS_PER_DAY;
    expect(live).toBe(expected);

    // Sanity: the same multiply in Number drifts from the exact BigInt result.
    const naiveNumber = Number(staked) * Number(dailyPool) * Number(elapsed);
    expect(BigInt(Math.trunc(naiveNumber))).not.toBe(numerator);
  });

  describe('fail-safe: never wrongly block a valid claim', () => {
    it('pool account missing → falls back to RAW field (not 0), estimateOk=false', async () => {
      const field = 5_096_000_000_000n;
      const stakeData = buildStakeBuffer({
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: field,
        lastAccrualAt: nowSeconds - 3_600n,
      });
      const conn = mockConn({ poolData: null });

      const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
      expect(live).toBe(field);
      expect(live).toBeGreaterThan(0n);
      expect(estimateOk).toBe(false); // estimate could not run
    });

    it('pool read throws → falls back to RAW field (not 0), estimateOk=false', async () => {
      const field = 2_500_000_000_000n;
      const stakeData = buildStakeBuffer({
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: field,
        lastAccrualAt: nowSeconds - 3_600n,
      });
      const conn = mockConn({ poolData: null, throws: true });

      const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
      expect(live).toBe(field);
      expect(estimateOk).toBe(false);
    });

    it('pool too short (< 24 bytes) → falls back to RAW field, estimateOk=false', async () => {
      const field = 999_000_000_000n;
      const stakeData = buildStakeBuffer({
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: field,
        lastAccrualAt: nowSeconds - 3_600n,
      });
      const conn = mockConn({ poolData: Buffer.alloc(16) });

      const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
      expect(live).toBe(field);
      expect(estimateOk).toBe(false);
    });

    // MEDIUM: the exact case the old code wrongly blocked — raw field is ALSO
    // 0 and the pool read FAILED. Must surface estimateOk=false so the caller
    // does NOT treat this as a genuine zero.
    it('raw field 0 + pool read FAILS → lamports 0 BUT estimateOk=false (UNKNOWN, do not block)', async () => {
      const stakeData = buildStakeBuffer({
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: 0n, // raw also 0 — the trap
        lastAccrualAt: nowSeconds - 3_600n,
      });
      const conn = mockConn({ poolData: null, throws: true });

      const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, stakeData, FAKE_POOL);
      expect(live).toBe(0n);
      expect(estimateOk).toBe(false); // <-- the discriminator that unblocks the claim
    });
  });

  it('stake buffer too short (< 194 bytes) → lamports 0 + estimateOk=true (genuine no-rewards)', async () => {
    const shortStake = buildStakeBuffer(
      {
        amountLamports: 1_000_000_000_000n,
        rewardsPendingLamports: 1n,
        lastAccrualAt: 1n,
      },
      180,
    );
    const conn = mockConn({ poolData: buildPoolBuffer(1n, 1n) });

    const { lamports: live, estimateOk } = await computeLiveClaimableLamports(conn, shortStake, FAKE_POOL);
    expect(live).toBe(0n);
    // Genuine no-readable-stake — NOT a transient pool failure, so the caller
    // correctly early-returns (estimateOk=true).
    expect(estimateOk).toBe(true);
  });
});
