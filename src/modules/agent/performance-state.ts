/**
 * Persists a rolling window of round outcomes for this node so the agent
 * can later reason about its own performance (e.g. flag a declining
 * trend, justify a model upgrade, throttle research participation when
 * results have been consistently bad).
 *
 * Audit 2026-04-25 (Bucket C3, scoped subset). The full feedback loop —
 * automatic model upgrades or capability disablement — is intentionally
 * deferred. This commit lands the data substrate + logging hook so a
 * future iteration can consume it without retrofitting.
 *
 * Module-level singleton because RoundListenerHelper writes it
 * unconditionally on `round.closed` and the agent graph reads it from
 * across the DI tree.
 */

import logger from '../../utils/logger';

export interface RoundOutcome {
  roundId: string;
  /** Closed timestamp in ms, captured at receive time. */
  recordedAtMs: number;
  /** This node's rank in the winners list, or null if it didn't place. */
  myRank: number | null;
  /** Reward in SYN (already lamports-divided); null when no reward. */
  myRewardSyn: number | null;
  /** Number of winners declared by the coordinator. */
  totalWinners: number;
}

const DEFAULT_WINDOW = 50;
function readEnvWindow(): number {
  const raw = process.env.PERFORMANCE_WINDOW;
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW;
}
let window = readEnvWindow();
let outcomes: RoundOutcome[] = [];

export function recordRoundOutcome(o: RoundOutcome): void {
  outcomes.push(o);
  while (outcomes.length > window) outcomes.shift();
  // Roll up a one-line summary every 5 rounds so the operator sees the
  // trend without having to scrape per-round logs.
  if (outcomes.length > 0 && outcomes.length % 5 === 0) {
    const stats = computeRollingStats();
    logger.log(
      `[Performance] last ${outcomes.length} rounds: ` +
        `placed ${stats.placedRounds}/${stats.totalRounds} (${stats.placedRate.toFixed(0)}%), ` +
        `avg rank ${stats.avgRank?.toFixed(2) ?? 'n/a'}, ` +
        `total reward ${stats.totalRewardSyn.toFixed(3)} SYN`,
    );

    // C3 deferred subset: emit a structured WARN once we have enough
    // signal AND the placedRate sits below the configured threshold for
    // the entire rolling window. Operators / dashboards can tail this
    // line to flag a node that needs a model upgrade or capability
    // review. Default 30% over 10+ rounds; override via
    // PERFORMANCE_LOW_PLACED_RATE.
    const minRoundsForFlag = 10;
    const lowRateThreshold = readLowPlacedRateThreshold();
    if (
      stats.totalRounds >= minRoundsForFlag &&
      stats.placedRate < lowRateThreshold
    ) {
      logger.warn(
        `[Performance] LOW PLACED RATE — last ${stats.totalRounds} rounds at ` +
          `${stats.placedRate.toFixed(0)}% (< ${lowRateThreshold}%). ` +
          `Consider upgrading the LLM or reviewing capabilities.`,
      );
    }
  }
}

function readLowPlacedRateThreshold(): number {
  const raw = process.env.PERFORMANCE_LOW_PLACED_RATE;
  const parsed = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(parsed)) return 30;
  // Clamp to [0,100] so a typo can't disable / always-fire the flag.
  return Math.max(0, Math.min(100, parsed));
}

export interface RollingStats {
  totalRounds: number;
  placedRounds: number;
  placedRate: number;
  avgRank: number | null;
  totalRewardSyn: number;
}

export function computeRollingStats(): RollingStats {
  const totalRounds = outcomes.length;
  const placed = outcomes.filter((o) => o.myRank !== null);
  const placedRounds = placed.length;
  const placedRate = totalRounds === 0 ? 0 : (placedRounds / totalRounds) * 100;
  const avgRank =
    placedRounds === 0
      ? null
      : placed.reduce((acc, o) => acc + (o.myRank ?? 0), 0) / placedRounds;
  const totalRewardSyn = outcomes.reduce(
    (acc, o) => acc + (o.myRewardSyn ?? 0),
    0,
  );
  return { totalRounds, placedRounds, placedRate, avgRank, totalRewardSyn };
}

export function getRecentOutcomes(): readonly RoundOutcome[] {
  return outcomes.slice();
}

export function setRollingWindow(size: number): void {
  if (!Number.isFinite(size) || size <= 0) return;
  window = Math.floor(size);
  while (outcomes.length > window) outcomes.shift();
}

/** Test-only reset helper. */
export function _resetPerformanceStateForTests(): void {
  outcomes = [];
  window = readEnvWindow();
}
