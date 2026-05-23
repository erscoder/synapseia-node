/**
 * Canonical live staking-reward estimation — the SINGLE source of truth for
 * the off-chain replica of the on-chain `get_rewards` / `calc_rewards` view.
 *
 * Two distinct callers must agree on this math byte-for-byte or the UI/CLI
 * drift from what `claim_rewards` actually pays:
 *   1. `src/cli/chain-info-lightweight.ts` — node-ui's 15s balance poll
 *      (added v0.8.110; what the Claim button reads to enable/disable).
 *   2. `src/modules/staking/staking-cli.ts` `claimStakingRewards()` — the
 *      pre-check that decides whether to build+send the claim tx.
 *
 * The raw on-chain `StakeAccount.rewards_pending` field is only advanced by
 * the coordinator's hourly accrue cron, which lags real time (~13h observed).
 * Reading it raw makes both consumers report "0 SYN" even when the wallet has
 * thousands of SYN claimable. The on-chain `claim_rewards` (syn_staking
 * lib.rs:535) self-accrues `now - last_accrual_at` before sweeping, so the
 * LIVE estimate below equals what a claim pays.
 *
 * P34: keep this formula in ONE place. Do NOT copy `calc_rewards` into a
 * consumer — import from here.
 */

/**
 * `SECONDS_PER_DAY` constant from
 * packages/contracts/programs/syn_staking/src/lib.rs:13
 * (`pub const SECONDS_PER_DAY: u64 = 86_400;`). Pinned verbatim — the
 * estimation below MUST match the on-chain divisor exactly or the live
 * preview drifts from what `claim_rewards` actually pays.
 */
export const SECONDS_PER_DAY = 86_400n;

// ── V3 StakeAccount byte offsets (absolute, into `account.data`; the 8-byte
// Anchor discriminator occupies [0-7]). Matches `pub struct StakeAccount` in
// syn_staking lib.rs, post F-contracts-003/004 (total size 227 bytes):
//   [8-39]    owner             Pubkey(32)
//   [40-71]   coord_authority   Pubkey(32)
//   [72-79]   amount            u64   ← staked lamports
//   [80]      tier              u8
//   [81-88]   lm                u64
//   [89]      ban_times         u8
//   [90-97]   banned_until      i64
//   [98-161]  ban_reason        [u8; 64]
//   [162-169] locked_until      i64
//   [170-177] rewards_pending   u64   ← raw field
//   [178-185] last_claim_at     i64
//   [186-193] last_accrual_at   i64
//   [194-226] pending_authority Option<Pubkey> (1 tag + 32)
export const STAKE_OFF_AMOUNT = 72;
export const STAKE_OFF_LOCKED_UNTIL = 162;
export const STAKE_OFF_REWARDS_PENDING = 170;
export const STAKE_OFF_LAST_ACCRUAL = 186;
/**
 * Minimum StakeAccount buffer length we will read from. `last_accrual_at`
 * (i64 @ 186) ends at byte 194, so anything shorter is a pre-upgrade buffer
 * whose tail bytes are stale/garbage — reject it rather than read junk.
 */
export const STAKE_MIN_LEN = 194;

// ── StakingPool byte offsets (absolute, after the 8-byte discriminator).
// Confirmed against `pub struct StakingPool` (syn_staking lib.rs:1817): the
// first two fields after the discriminator are `daily_pool_lamports` then
// `total_staked`.
export const POOL_OFF_DAILY_POOL = 8;
export const POOL_OFF_TOTAL_STAKED = 16;
/** Minimum pool buffer length to read both u64 fields (16 + 8). */
export const POOL_MIN_LEN = 24;

export interface StakingPoolParams {
  dailyPoolLamports: bigint;
  totalStakedLamports: bigint;
}

/**
 * Decode `daily_pool_lamports` + `total_staked` from a raw [b"staking_pool"]
 * PDA buffer. Returns null when the buffer is missing or too short, so callers
 * fall back to the raw `rewards_pending` field. Pure — no I/O.
 */
export function readStakingPoolParams(data: Buffer | null | undefined): StakingPoolParams | null {
  if (!data || data.length < POOL_MIN_LEN) return null;
  return {
    dailyPoolLamports: data.readBigUInt64LE(POOL_OFF_DAILY_POOL),
    totalStakedLamports: data.readBigUInt64LE(POOL_OFF_TOTAL_STAKED),
  };
}

/**
 * Pure replica of the on-chain `calc_rewards` (syn_staking lib.rs:1392):
 *
 *   reward(u128) = staked * daily_pool_lamports * elapsed_seconds
 *                  / total_staked / SECONDS_PER_DAY
 *
 * All inputs and the multiply-then-divide are done in BigInt so we match
 * Rust's u128 integer semantics exactly (multiply ALL three numerators
 * FIRST, then divide by total_staked, then by SECONDS_PER_DAY — each a
 * floor integer division). Any zero input → 0, mirroring the contract's
 * `if staked==0 || elapsed==0 || daily_pool==0 || total==0 { return 0 }`.
 * Returns lamports (BigInt). u64::MAX clamp omitted: real pool params
 * never approach it and a clamp would only ever *under*-report.
 */
export function calcRewardsLamports(
  stakedLamports: bigint,
  elapsedSeconds: bigint,
  dailyPoolLamports: bigint,
  totalStakedLamports: bigint,
): bigint {
  if (
    stakedLamports <= 0n ||
    elapsedSeconds <= 0n ||
    dailyPoolLamports <= 0n ||
    totalStakedLamports <= 0n
  ) {
    return 0n;
  }
  return (
    (stakedLamports * dailyPoolLamports * elapsedSeconds) /
    totalStakedLamports /
    SECONDS_PER_DAY
  );
}

/**
 * Replica of the on-chain `get_rewards` view (syn_staking lib.rs:565):
 *
 *   elapsed = last_accrual_at > 0 ? max(0, now - last_accrual_at) : 0
 *   total   = rewards_pending + (amount > 0 ? calc_rewards(...) : 0)
 *
 * All args are raw lamports / unix-second BigInts read straight off the
 * StakeAccount + StakingPool buffers. Returns the LIVE claimable amount
 * in lamports (BigInt). Caller divides by 1e9 (in Number) for UI units.
 */
export function estimateLiveRewardsLamports(params: {
  rewardsPendingLamports: bigint;
  stakedLamports: bigint;
  lastAccrualAt: bigint;
  nowSeconds: bigint;
  dailyPoolLamports: bigint;
  totalStakedLamports: bigint;
}): bigint {
  const {
    rewardsPendingLamports,
    stakedLamports,
    lastAccrualAt,
    nowSeconds,
    dailyPoolLamports,
    totalStakedLamports,
  } = params;
  const elapsed =
    lastAccrualAt > 0n
      ? (() => {
          const delta = nowSeconds - lastAccrualAt;
          return delta > 0n ? delta : 0n;
        })()
      : 0n;
  const estimated =
    stakedLamports > 0n
      ? calcRewardsLamports(stakedLamports, elapsed, dailyPoolLamports, totalStakedLamports)
      : 0n;
  return rewardsPendingLamports + estimated;
}

/**
 * Minimal structural type for the one `@solana/web3.js` Connection method
 * `computeLiveClaimableLamports` needs. Keeps this module free of the heavy
 * `@solana/web3.js` / `@inquirer/prompts` imports that `staking-cli.ts` pulls
 * in, so the gate logic stays unit-testable in isolation.
 */
export interface AccountInfoReader {
  getAccountInfo(pubkey: unknown): Promise<{ data: Buffer } | null>;
}

/**
 * Discriminated result of `computeLiveClaimableLamports`. `estimateOk`
 * distinguishes a GENUINE zero (the live math ran end-to-end and the wallet
 * truly has nothing claimable) from an UNKNOWN zero (the staking_pool read /
 * estimate threw or the pool was missing/short, so we fell back to the raw
 * `rewards_pending` field — which is itself 0). The caller MUST treat those
 * two cases differently: a genuine zero blocks the claim; an unknown zero
 * must NOT block, because the wallet may hold live-but-unaccrued rewards that
 * only the on-chain ix can see.
 *   - `lamports`   : the live claimable estimate (or raw-field fallback) in lamports.
 *   - `estimateOk` : true when the live `get_rewards` math ran (or the buffer
 *                    was a genuine no-rewards short buffer); false ONLY when the
 *                    pool read / estimate failed and we fell back to the raw field.
 */
export interface LiveClaimableResult {
  lamports: bigint;
  estimateOk: boolean;
}

/**
 * Compute the LIVE claimable rewards (in lamports, BigInt) for a stake
 * account, mirroring the on-chain `get_rewards` view: raw `rewards_pending`
 * field + `calc_rewards(amount, now - last_accrual_at, daily_pool, total)`.
 * This is the pre-check gate for `claimStakingRewards`. Same math node-ui's
 * chain-info poll uses (P34 single source).
 *
 * Returns a {@link LiveClaimableResult}. `estimateOk` lets the caller tell a
 * GENUINE zero from an UNKNOWN zero:
 *   - Live math ran → `estimateOk: true`. `lamports` is the true live estimate.
 *   - Pool missing / too short / read threw → `estimateOk: false`, and we FALL
 *     BACK to the raw `rewards_pending` field. The raw field is a lower bound
 *     on the true claimable (the on-chain ix self-accrues on top), so it can
 *     only ever *under*-report. When that fallback is itself 0 the caller must
 *     NOT block — `estimateOk: false` signals "unknown, let the ix decide".
 *   - Stake buffer too short / pre-upgrade (< STAKE_MIN_LEN) → `lamports: 0n`
 *     with `estimateOk: true`. This is a GENUINE no-rewards (no readable stake
 *     state), NOT a transient failure, so the caller correctly early-returns.
 *
 * The on-chain `claim_rewards` ix fails closed harmlessly when there is truly
 * nothing to claim: `require!(rewards_to_claim > 0, NoRewardsToClaim)`
 * (syn_staking lib.rs:544). So proceeding on an unknown zero costs at most a
 * reverted-tx fee, while blocking it would strand real rewards.
 *
 * @param connection   reader exposing `getAccountInfo` (real Connection or mock)
 * @param stakeData     raw `account.data` of the StakeAccount (already fetched)
 * @param stakingPool   [b"staking_pool"] PDA address to read pool params from
 */
export async function computeLiveClaimableLamports(
  connection: AccountInfoReader,
  stakeData: Buffer,
  stakingPool: unknown,
): Promise<LiveClaimableResult> {
  // Guard against a pre-upgrade / truncated buffer: reading rewards_pending
  // (offset 170) or last_accrual_at (offset 186) past the end would throw.
  // A short buffer means no readable stake state → GENUINE zero (estimateOk),
  // not a transient pool failure, so the caller correctly early-returns.
  if (stakeData.length < STAKE_MIN_LEN) return { lamports: 0n, estimateOk: true };

  const rewardsPendingLamports = stakeData.readBigUInt64LE(STAKE_OFF_REWARDS_PENDING);

  try {
    const amountLamports = stakeData.readBigUInt64LE(STAKE_OFF_AMOUNT);
    const lastAccrualAt = stakeData.readBigInt64LE(STAKE_OFF_LAST_ACCRUAL);

    const poolInfo = await connection.getAccountInfo(stakingPool);
    const pool = readStakingPoolParams(poolInfo?.data ?? null);
    if (!pool) {
      // Pool missing/too short — estimate FAILED. Fall back to the raw field
      // but flag estimateOk=false so a raw==0 here does NOT block the claim.
      return { lamports: rewardsPendingLamports, estimateOk: false };
    }

    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const lamports = estimateLiveRewardsLamports({
      rewardsPendingLamports,
      stakedLamports: amountLamports,
      lastAccrualAt,
      nowSeconds,
      dailyPoolLamports: pool.dailyPoolLamports,
      totalStakedLamports: pool.totalStakedLamports,
    });
    return { lamports, estimateOk: true };
  } catch {
    // Pool read / estimation failed for any reason — fall back to the raw
    // field so a transient RPC error never blocks a legitimate claim. Flag
    // estimateOk=false so a raw==0 fallback is treated as UNKNOWN, not zero.
    return { lamports: rewardsPendingLamports, estimateOk: false };
  }
}
