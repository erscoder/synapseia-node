/**
 * D-P2P Slice 1 (2026-05-28) — DiscoverySourceCounter tests.
 *
 * Covers:
 *   - increment(source, delta) accumulates per-source totals.
 *   - default delta = 1.
 *   - non-positive / non-finite deltas are dropped silently.
 *   - snapshot() is non-destructive.
 *   - readAndReset() zeros both sides AND returns null on idle ticks.
 *   - interleaved increments + read-and-reset preserve monotone semantics.
 *   - singleton handle returns the same instance per process.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  DiscoverySourceCounter,
  getDiscoverySourceCounter,
  __resetDiscoverySourceCounterForTests,
} from '../discovery-source.metric';

describe('DiscoverySourceCounter', () => {
  let counter: DiscoverySourceCounter;

  beforeEach(() => {
    counter = new DiscoverySourceCounter();
  });

  it('starts at zero on both sources', () => {
    expect(counter.snapshot()).toEqual({ gossipsub: 0, poll: 0 });
  });

  it('increment(gossipsub, 3) bumps only the gossipsub side', () => {
    counter.increment('gossipsub', 3);
    expect(counter.snapshot()).toEqual({ gossipsub: 3, poll: 0 });
  });

  it('increment(poll, 5) bumps only the poll side', () => {
    counter.increment('poll', 5);
    expect(counter.snapshot()).toEqual({ gossipsub: 0, poll: 5 });
  });

  it('default delta is 1 when omitted', () => {
    counter.increment('gossipsub');
    counter.increment('poll');
    counter.increment('gossipsub');
    expect(counter.snapshot()).toEqual({ gossipsub: 2, poll: 1 });
  });

  it('non-positive delta is dropped (zero, negative)', () => {
    counter.increment('gossipsub', 0);
    counter.increment('poll', -5);
    expect(counter.snapshot()).toEqual({ gossipsub: 0, poll: 0 });
  });

  it('non-finite delta is dropped (NaN, Infinity, -Infinity)', () => {
    counter.increment('gossipsub', Number.NaN);
    counter.increment('poll', Number.POSITIVE_INFINITY);
    counter.increment('gossipsub', Number.NEGATIVE_INFINITY);
    expect(counter.snapshot()).toEqual({ gossipsub: 0, poll: 0 });
  });

  it('snapshot() is non-destructive', () => {
    counter.increment('gossipsub', 7);
    const first = counter.snapshot();
    const second = counter.snapshot();
    expect(first).toEqual({ gossipsub: 7, poll: 0 });
    expect(second).toEqual({ gossipsub: 7, poll: 0 });
  });

  it('readAndReset() zeroes both sides AND returns the prior delta', () => {
    counter.increment('gossipsub', 4);
    counter.increment('poll', 2);
    const delta = counter.readAndReset();
    expect(delta).toEqual({ gossipsub: 4, poll: 2 });
    expect(counter.snapshot()).toEqual({ gossipsub: 0, poll: 0 });
  });

  it('readAndReset() returns null when both sides are zero (idle tick)', () => {
    expect(counter.readAndReset()).toBeNull();
    expect(counter.snapshot()).toEqual({ gossipsub: 0, poll: 0 });
  });

  it('interleaved increment + readAndReset preserve monotone-friendly deltas', () => {
    counter.increment('gossipsub', 3);
    expect(counter.readAndReset()).toEqual({ gossipsub: 3, poll: 0 });
    counter.increment('poll', 2);
    counter.increment('gossipsub', 1);
    expect(counter.readAndReset()).toEqual({ gossipsub: 1, poll: 2 });
    expect(counter.readAndReset()).toBeNull();
  });

  it('readAndReset() returns the delta even when only one side is non-zero', () => {
    counter.increment('gossipsub', 10);
    expect(counter.readAndReset()).toEqual({ gossipsub: 10, poll: 0 });
    counter.increment('poll', 4);
    expect(counter.readAndReset()).toEqual({ gossipsub: 0, poll: 4 });
  });

  it('__resetForTests() wipes both sides without returning anything', () => {
    counter.increment('gossipsub', 99);
    counter.increment('poll', 100);
    counter.__resetForTests();
    expect(counter.snapshot()).toEqual({ gossipsub: 0, poll: 0 });
  });
});

describe('getDiscoverySourceCounter() — singleton', () => {
  beforeEach(() => {
    __resetDiscoverySourceCounterForTests();
  });

  it('returns the SAME instance on repeated calls', () => {
    const a = getDiscoverySourceCounter();
    const b = getDiscoverySourceCounter();
    expect(a).toBe(b);
  });

  it('increments through the singleton are visible to a second handle', () => {
    getDiscoverySourceCounter().increment('gossipsub', 5);
    expect(getDiscoverySourceCounter().snapshot()).toEqual({
      gossipsub: 5,
      poll: 0,
    });
  });

  it('__resetDiscoverySourceCounterForTests() wipes the singleton', () => {
    getDiscoverySourceCounter().increment('poll', 12);
    __resetDiscoverySourceCounterForTests();
    expect(getDiscoverySourceCounter().snapshot()).toEqual({
      gossipsub: 0,
      poll: 0,
    });
  });
});
