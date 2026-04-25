import {
  recordRoundOutcome,
  computeRollingStats,
  getRecentOutcomes,
  setRollingWindow,
  _resetPerformanceStateForTests,
} from '../performance-state';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('performance-state', () => {
  beforeEach(() => _resetPerformanceStateForTests());

  it('starts empty', () => {
    expect(getRecentOutcomes()).toEqual([]);
    const stats = computeRollingStats();
    expect(stats.totalRounds).toBe(0);
    expect(stats.placedRate).toBe(0);
    expect(stats.avgRank).toBeNull();
  });

  it('records outcomes and exposes a copy (not the live array)', () => {
    recordRoundOutcome({
      roundId: 'r1',
      recordedAtMs: 1,
      myRank: 1,
      myRewardSyn: 100,
      totalWinners: 3,
    });
    const snap = getRecentOutcomes();
    expect(snap).toHaveLength(1);
    (snap as unknown as unknown[]).length = 0;
    expect(getRecentOutcomes()).toHaveLength(1);
  });

  it('computes correct stats from a mixed window', () => {
    recordRoundOutcome({ roundId: 'r1', recordedAtMs: 1, myRank: 1, myRewardSyn: 100, totalWinners: 3 });
    recordRoundOutcome({ roundId: 'r2', recordedAtMs: 2, myRank: 3, myRewardSyn: 30, totalWinners: 3 });
    recordRoundOutcome({ roundId: 'r3', recordedAtMs: 3, myRank: null, myRewardSyn: null, totalWinners: 3 });

    const stats = computeRollingStats();
    expect(stats.totalRounds).toBe(3);
    expect(stats.placedRounds).toBe(2);
    expect(stats.placedRate).toBeCloseTo(66.67, 1);
    expect(stats.avgRank).toBe(2);
    expect(stats.totalRewardSyn).toBe(130);
  });

  it('rotates oldest entries when the window fills', () => {
    setRollingWindow(3);
    for (let i = 0; i < 5; i += 1) {
      recordRoundOutcome({
        roundId: `r${i}`,
        recordedAtMs: i,
        myRank: i + 1,
        myRewardSyn: 10,
        totalWinners: 1,
      });
    }
    const snap = getRecentOutcomes();
    expect(snap).toHaveLength(3);
    expect(snap.map((o) => o.roundId)).toEqual(['r2', 'r3', 'r4']);
  });

  it('setRollingWindow rejects non-positive values', () => {
    setRollingWindow(0);
    setRollingWindow(-1);
    setRollingWindow(NaN);
    // No throw, no change in default behavior — push 1 row to confirm.
    recordRoundOutcome({ roundId: 'r1', recordedAtMs: 0, myRank: 1, myRewardSyn: 1, totalWinners: 1 });
    expect(getRecentOutcomes()).toHaveLength(1);
  });
});
