import {
  recordRoundOutcome,
  computeRollingStats,
  getRecentOutcomes,
  setRollingWindow,
  _resetPerformanceStateForTests,
} from '../performance-state';

const mockLog = jest.fn();
const mockWarn = jest.fn();
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: {
    log: (...a: unknown[]) => mockLog(...a),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: jest.fn(),
  },
}));

describe('performance-state', () => {
  beforeEach(() => {
    mockLog.mockClear();
    mockWarn.mockClear();
    delete process.env.PERFORMANCE_WINDOW;
    delete process.env.PERFORMANCE_LOW_PLACED_RATE;
    _resetPerformanceStateForTests();
  });

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

  it('emits a [Performance] summary log every five recorded rounds', () => {
    for (let i = 0; i < 5; i += 1) {
      recordRoundOutcome({
        roundId: `r${i}`,
        recordedAtMs: i,
        myRank: i % 3 === 0 ? 1 : null,
        myRewardSyn: i % 3 === 0 ? 50 : null,
        totalWinners: 3,
      });
    }
    const summary = mockLog.mock.calls.find((c) =>
      String(c[0]).includes('[Performance]'),
    );
    expect(summary).toBeDefined();
    expect(String(summary?.[0])).toContain('last 5 rounds');
    expect(String(summary?.[0])).toContain('placed');
  });

  it('reads PERFORMANCE_WINDOW env var on reset', () => {
    process.env.PERFORMANCE_WINDOW = '2';
    _resetPerformanceStateForTests();
    for (let i = 0; i < 4; i += 1) {
      recordRoundOutcome({ roundId: `e${i}`, recordedAtMs: i, myRank: 1, myRewardSyn: 1, totalWinners: 1 });
    }
    expect(getRecentOutcomes()).toHaveLength(2);
  });

  it('ignores malformed PERFORMANCE_WINDOW and keeps the default window', () => {
    process.env.PERFORMANCE_WINDOW = 'not-a-number';
    _resetPerformanceStateForTests();
    // Push >50 to overflow the default — only 50 should remain.
    for (let i = 0; i < 60; i += 1) {
      recordRoundOutcome({ roundId: `b${i}`, recordedAtMs: i, myRank: 1, myRewardSyn: 1, totalWinners: 1 });
    }
    expect(getRecentOutcomes()).toHaveLength(50);
  });

  describe('low-placed-rate flag (C3 deferred)', () => {
    it('emits a WARN when 10+ rounds at < 30% placed rate', () => {
      // 10 rounds with placedRate = 0%
      for (let i = 0; i < 10; i += 1) {
        recordRoundOutcome({ roundId: `r${i}`, recordedAtMs: i, myRank: null, myRewardSyn: null, totalWinners: 3 });
      }
      const flag = mockWarn.mock.calls.find((c) => String(c[0]).includes('LOW PLACED RATE'));
      expect(flag).toBeDefined();
      expect(String(flag?.[0])).toContain('< 30%');
    });

    it('does NOT emit the WARN below the minimum-rounds threshold (5 rounds)', () => {
      for (let i = 0; i < 5; i += 1) {
        recordRoundOutcome({ roundId: `r${i}`, recordedAtMs: i, myRank: null, myRewardSyn: null, totalWinners: 3 });
      }
      const flag = mockWarn.mock.calls.find((c) => String(c[0]).includes('LOW PLACED RATE'));
      expect(flag).toBeUndefined();
    });

    it('does NOT emit when placedRate sits above the threshold', () => {
      for (let i = 0; i < 10; i += 1) {
        recordRoundOutcome({
          roundId: `r${i}`,
          recordedAtMs: i,
          myRank: 1,
          myRewardSyn: 50,
          totalWinners: 3,
        });
      }
      const flag = mockWarn.mock.calls.find((c) => String(c[0]).includes('LOW PLACED RATE'));
      expect(flag).toBeUndefined();
    });

    it('honors PERFORMANCE_LOW_PLACED_RATE override', () => {
      process.env.PERFORMANCE_LOW_PLACED_RATE = '80';
      // 10 rounds with placedRate=50% — below 80%, should flag.
      for (let i = 0; i < 10; i += 1) {
        recordRoundOutcome({
          roundId: `r${i}`,
          recordedAtMs: i,
          myRank: i % 2 === 0 ? 1 : null,
          myRewardSyn: i % 2 === 0 ? 1 : null,
          totalWinners: 3,
        });
      }
      const flag = mockWarn.mock.calls.find((c) => String(c[0]).includes('LOW PLACED RATE'));
      expect(flag).toBeDefined();
      expect(String(flag?.[0])).toContain('< 80%');
    });

    it('clamps absurd PERFORMANCE_LOW_PLACED_RATE to [0,100]', () => {
      process.env.PERFORMANCE_LOW_PLACED_RATE = '999';
      // 100% placed → still should NOT fire because clamp puts threshold at 100,
      // and 100 < 100 is false.
      for (let i = 0; i < 10; i += 1) {
        recordRoundOutcome({ roundId: `r${i}`, recordedAtMs: i, myRank: 1, myRewardSyn: 1, totalWinners: 3 });
      }
      const flag = mockWarn.mock.calls.find((c) => String(c[0]).includes('LOW PLACED RATE'));
      expect(flag).toBeUndefined();
    });
  });
});
