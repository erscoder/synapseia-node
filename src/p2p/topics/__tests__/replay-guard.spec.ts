/**
 * Tests for the bounded `ReplayGuard` used by the coordinator-envelope
 * verify path.
 */
import { REPLAY_GUARD_PRUNE_THRESHOLD, ReplayGuard } from '../replay-guard';

describe('ReplayGuard', () => {
  const nowMs = 1_700_000_000_000;

  it('accepts a signature the first time and rejects it the second', () => {
    const guard = new ReplayGuard(60);
    expect(guard.seenBefore('sig-A', nowMs)).toBe(false);
    expect(guard.seenBefore('sig-A', nowMs)).toBe(true);
  });

  it('treats distinct signatures independently', () => {
    const guard = new ReplayGuard(60);
    expect(guard.seenBefore('sig-A', nowMs)).toBe(false);
    expect(guard.seenBefore('sig-B', nowMs)).toBe(false);
    expect(guard.seenBefore('sig-A', nowMs)).toBe(true);
    expect(guard.seenBefore('sig-B', nowMs)).toBe(true);
  });

  it('forgets a signature once its TTL (freshness window) lapses', () => {
    const guard = new ReplayGuard(60); // 60s TTL
    expect(guard.seenBefore('sig-A', nowMs)).toBe(false);
    // 61s later the entry has expired → treated as never-seen.
    const later = nowMs + 61_000;
    expect(guard.seenBefore('sig-A', later)).toBe(false);
    // …and is re-recorded.
    expect(guard.seenBefore('sig-A', later)).toBe(true);
  });

  it('still remembers a signature at the edge of the TTL window', () => {
    const guard = new ReplayGuard(60);
    expect(guard.seenBefore('sig-A', nowMs)).toBe(false);
    // 59s later — still within the 60s TTL → replay.
    expect(guard.seenBefore('sig-A', nowMs + 59_000)).toBe(true);
  });

  it('opportunistically prunes expired entries past the size threshold', () => {
    const guard = new ReplayGuard(60);
    // Seed THRESHOLD + 1 distinct expired-able signatures at t0.
    for (let i = 0; i <= REPLAY_GUARD_PRUNE_THRESHOLD; i++) {
      guard.seenBefore(`old-${i}`, nowMs);
    }
    // Far in the future: all the old entries have expired. The next call
    // crosses the threshold and triggers the sweep, dropping them.
    const future = nowMs + 120_000;
    expect(guard.seenBefore('fresh', future)).toBe(false);

    const internalMapSize = (guard as unknown as { seen: Map<string, number> })
      .seen.size;
    // After the sweep only the 'fresh' entry remains (all old ones pruned).
    expect(internalMapSize).toBe(1);
  });
});
