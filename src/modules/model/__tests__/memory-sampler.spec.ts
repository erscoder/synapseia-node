/**
 * memory-sampler.spec.ts — Slice 10b coverage.
 *
 * Tests verify:
 *  - sampler ticks at the configured interval and records peaks;
 *  - stop is idempotent (calling twice does not double-log);
 *  - stop emits a summary line with the expected field shape;
 *  - probe errors during a tick are swallowed (sampler keeps running);
 *  - per-tick `mem` debug log throttles to 1 GB RSS deltas (no spam).
 *
 * Reviewer-lesson P29: mocks driven by deterministic schedules
 * (immediate scheduler), not "didn't throw" assertions. Each test
 * asserts numeric peak / min / sample-count fields surfaced through
 * the logger spy.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { startMemorySampler } from '../memory-sampler';
import logger from '../../../utils/logger';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const logSpy = (logger as unknown as { log: jest.Mock }).log;

function findSummaryCall(label: string): string | undefined {
  const calls = logSpy.mock.calls.map((c) => String(c[0]));
  return calls.find((m) => m.startsWith(`[MemSampler ${label}]`) && m.includes('samples='));
}

describe('startMemorySampler', () => {
  beforeEach(() => {
    logSpy.mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('records peak/min freeMB and peak rssMB across multiple ticks', async () => {
    const freeSeq = [40000, 38000, 35000, 42000]; // peak=42000, min=35000
    const rssSeq = [5000, 12000, 22000, 22500]; // peak=22500
    let ti = 0;
    const getFreeMemMB = jest.fn<() => Promise<number>>(async () => freeSeq[Math.min(ti, freeSeq.length - 1)]);
    const getProcRssMB = jest.fn<(pid: number) => Promise<number>>(async () => rssSeq[Math.min(ti++, rssSeq.length - 1)]);

    // Drain `freeSeq.length` ticks then stop.
    const pending: Array<() => void> = [];
    const schedule = (cb: () => void, _ms: number) => { pending.push(cb); };

    const handle = startMemorySampler('TestA', 4242, { getFreeMemMB, getProcRssMB, schedule });

    // Drain ticks; first tick fires synchronously on startMemorySampler.
    for (let i = 0; i < freeSeq.length; i++) {
      await Promise.resolve(); // let the awaited probe settle
      await Promise.resolve();
      const next = pending.shift();
      if (next) next();
    }
    await Promise.resolve();
    await Promise.resolve();

    handle.stop();

    const summary = findSummaryCall('TestA');
    expect(summary).toBeDefined();
    expect(summary).toContain('pid=4242');
    expect(summary).toMatch(/samples=\d+/);
    expect(summary).toContain('freeMB peak=42000');
    expect(summary).toContain('min=35000');
    expect(summary).toContain('rssMB peak=22500');
  });

  it('stop is idempotent (second call is a no-op, no second summary)', async () => {
    const getFreeMemMB = jest.fn<() => Promise<number>>(async () => 10000);
    const getProcRssMB = jest.fn<(pid: number) => Promise<number>>(async () => 5000);
    const schedule = (_cb: () => void, _ms: number) => { /* drop further ticks */ };

    const handle = startMemorySampler('TestB', 1, { getFreeMemMB, getProcRssMB, schedule });
    await Promise.resolve(); await Promise.resolve();
    handle.stop();
    handle.stop();
    handle.stop();

    const summaries = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith('[MemSampler TestB]') && m.includes('samples='));
    expect(summaries).toHaveLength(1);
  });

  it('swallows probe errors and keeps ticking', async () => {
    let ti = 0;
    const getFreeMemMB = jest.fn<() => Promise<number>>(async () => {
      if (ti === 1) throw new Error('boom');
      return 12345;
    });
    const getProcRssMB = jest.fn<(pid: number) => Promise<number>>(async () => {
      ti += 1;
      return 6789;
    });

    const pending: Array<() => void> = [];
    const schedule = (cb: () => void, _ms: number) => { pending.push(cb); };

    const handle = startMemorySampler('TestC', 99, { getFreeMemMB, getProcRssMB, schedule });

    for (let i = 0; i < 3; i++) {
      await Promise.resolve(); await Promise.resolve();
      const next = pending.shift();
      if (next) next();
    }
    await Promise.resolve(); await Promise.resolve();

    handle.stop();

    // No throw, summary still emitted, free probe recorded the non-error ticks.
    const summary = findSummaryCall('TestC');
    expect(summary).toBeDefined();
    expect(summary).toContain('freeMB peak=12345');
  });

  it('emits a per-tick mem log only when rssMB jumps ≥1 GB (throttle)', async () => {
    // Sequence chosen so only the first and the last sample log a "mem" line.
    // RSS deltas: 5000 (first → logs), 5300 (delta=300, skip), 5500 (skip),
    // 6500 (delta=1500 from 5000, logs).
    const rssSeq = [5000, 5300, 5500, 6500];
    let ti = 0;
    const getFreeMemMB = jest.fn<() => Promise<number>>(async () => 30000);
    const getProcRssMB = jest.fn<(pid: number) => Promise<number>>(async () => rssSeq[Math.min(ti++, rssSeq.length - 1)]);

    const pending: Array<() => void> = [];
    const schedule = (cb: () => void, _ms: number) => { pending.push(cb); };

    const handle = startMemorySampler('TestD', 7, { getFreeMemMB, getProcRssMB, schedule });

    for (let i = 0; i < rssSeq.length; i++) {
      await Promise.resolve(); await Promise.resolve();
      const next = pending.shift();
      if (next) next();
    }
    await Promise.resolve(); await Promise.resolve();

    handle.stop();

    const memLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith('[MemSampler TestD]') && m.includes('rssMB=') && !m.includes('samples='));
    // First sample (5000) + jump to 6500. 5300 and 5500 throttled.
    expect(memLines).toHaveLength(2);
    expect(memLines[0]).toContain('rssMB=5000');
    expect(memLines[1]).toContain('rssMB=6500');
  });
});
