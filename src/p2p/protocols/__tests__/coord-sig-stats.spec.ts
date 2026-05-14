/**
 * Tests for coord-sig-stats — rolling-window + rate-limited diagnostics
 * for coord Ed25519 envelope verification.
 */
import {
  CRISIS_WINDOW,
  EXPECTED_COORD_PUBKEY_PREFIX,
  WARN_THROTTLE_MS,
  checkMismatchCrisis,
  recordVerify,
  resetStats,
  shouldEmitWarn,
} from '../coord-sig-stats';

describe('coord-sig-stats', () => {
  beforeEach(() => {
    resetStats();
  });

  describe('shouldEmitWarn', () => {
    it('emits on first call for a (topic, sigPrefix) fingerprint', () => {
      const r = shouldEmitWarn('WORK_ORDER_AVAILABLE', 'abc12345', 1_000);
      expect(r).toEqual({ emit: true, suppressed: 0 });
    });

    it('suppresses subsequent calls within the throttle window and counts them', () => {
      shouldEmitWarn('WORK_ORDER_AVAILABLE', 'abc12345', 1_000);
      const r2 = shouldEmitWarn('WORK_ORDER_AVAILABLE', 'abc12345', 2_000);
      expect(r2).toEqual({ emit: false, suppressed: 1 });
      const r3 = shouldEmitWarn('WORK_ORDER_AVAILABLE', 'abc12345', 3_000);
      expect(r3).toEqual({ emit: false, suppressed: 2 });
    });

    it('re-emits after the throttle window expires and resets the suppressed counter', () => {
      shouldEmitWarn('WORK_ORDER_AVAILABLE', 'abc12345', 1_000);
      shouldEmitWarn('WORK_ORDER_AVAILABLE', 'abc12345', 2_000);
      shouldEmitWarn('WORK_ORDER_AVAILABLE', 'abc12345', 3_000);
      const r = shouldEmitWarn(
        'WORK_ORDER_AVAILABLE',
        'abc12345',
        1_000 + WARN_THROTTLE_MS + 1,
      );
      expect(r).toEqual({ emit: true, suppressed: 2 });
      // After emit, counter must be 0 again.
      const r2 = shouldEmitWarn(
        'WORK_ORDER_AVAILABLE',
        'abc12345',
        1_000 + WARN_THROTTLE_MS + 100,
      );
      expect(r2).toEqual({ emit: false, suppressed: 1 });
    });

    it('throttles each (topic, sigPrefix) independently', () => {
      shouldEmitWarn('WORK_ORDER_AVAILABLE', 'aaaaaaaa', 1_000);
      const other = shouldEmitWarn('WORK_ORDER_AVAILABLE', 'bbbbbbbb', 1_001);
      expect(other).toEqual({ emit: true, suppressed: 0 });
      const otherTopic = shouldEmitWarn(
        'EVALUATION_ASSIGNMENTS',
        'aaaaaaaa',
        1_002,
      );
      expect(otherTopic).toEqual({ emit: true, suppressed: 0 });
    });

    it('prunes throttle entries older than 2 × WARN_THROTTLE_MS', () => {
      shouldEmitWarn('WORK_ORDER_AVAILABLE', 'old00000', 1_000);
      // Advance far beyond the prune cutoff, then probe a new fingerprint.
      // The old entry should be gone; the same fingerprint should emit
      // again as if first-seen (suppressed=0).
      const r = shouldEmitWarn(
        'WORK_ORDER_AVAILABLE',
        'old00000',
        1_000 + 3 * WARN_THROTTLE_MS,
      );
      // Either emit=true (rearm because pruned) OR emit=true (rearm by
      // throttle expiry with suppressed=0 since prune removed counter).
      // We assert the *observable* contract: emit=true and suppressed=0.
      expect(r.emit).toBe(true);
      expect(r.suppressed).toBe(0);
    });
  });

  describe('checkMismatchCrisis', () => {
    it('returns null while the window has fewer than CRISIS_WINDOW samples', () => {
      for (let i = 0; i < CRISIS_WINDOW - 1; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', false);
      }
      expect(checkMismatchCrisis()).toBeNull();
    });

    it('returns null when fail ratio is ≤ 50% (15 ok + 5 fail = 25%)', () => {
      for (let i = 0; i < 15; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', true);
      }
      for (let i = 0; i < 5; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', false);
      }
      expect(checkMismatchCrisis()).toBeNull();
    });

    it('returns the operator-facing ERROR when fail ratio > 50% (11 fail + 9 ok)', () => {
      for (let i = 0; i < 11; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', false);
      }
      for (let i = 0; i < 9; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', true);
      }
      const msg = checkMismatchCrisis();
      expect(msg).not.toBeNull();
      expect(msg).toContain(EXPECTED_COORD_PUBKEY_PREFIX);
      expect(msg).toContain('npm install -g @synapseia-network/node@latest');
      expect(msg).toContain('Coord-Verify');
    });

    it('fires the ERROR at most once per process even if crisis condition persists', () => {
      for (let i = 0; i < 20; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', false);
      }
      expect(checkMismatchCrisis()).not.toBeNull();
      // Still all-fail, but already fired → no spam.
      recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', false);
      expect(checkMismatchCrisis()).toBeNull();
      expect(checkMismatchCrisis()).toBeNull();
    });

    it('drops old samples from the rolling window so transient mismatches do not fire forever', () => {
      // Fill with 20 OKs (healthy steady state).
      for (let i = 0; i < CRISIS_WINDOW; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', true);
      }
      expect(checkMismatchCrisis()).toBeNull();
      // Push 5 fails — window now 15 ok + 5 fail = 25%, still below threshold.
      for (let i = 0; i < 5; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', false);
      }
      expect(checkMismatchCrisis()).toBeNull();
    });
  });

  describe('resetStats', () => {
    it('clears throttle map, rolling window, and crisis latch', () => {
      shouldEmitWarn('WORK_ORDER_AVAILABLE', 'aaaaaaaa', 1_000);
      for (let i = 0; i < 20; i++) {
        recordVerify('WORK_ORDER_AVAILABLE', 'aaaaaaaa', false);
      }
      expect(checkMismatchCrisis()).not.toBeNull();

      resetStats();

      // After reset, behaves like a brand-new process.
      const r = shouldEmitWarn('WORK_ORDER_AVAILABLE', 'aaaaaaaa', 1_000);
      expect(r).toEqual({ emit: true, suppressed: 0 });
      expect(checkMismatchCrisis()).toBeNull();
    });
  });
});
