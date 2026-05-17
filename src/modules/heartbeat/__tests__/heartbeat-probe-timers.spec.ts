/**
 * Bug 23 (HIGH) — heartbeat probe timer leak.
 *
 * Live evidence: Jest run printed "A worker process has failed to exit
 * gracefully" after the heartbeat suite. Root cause: both
 * `isLoraStackAvailable` (60s) and `isCudaAvailable` (30s) created
 * setTimeout watchdogs that killed the python probe on timeout but
 * never invoked clearTimeout on the success / error paths. The timer
 * remained pending in the libuv timer heap until firing, pinning the
 * event loop and delaying graceful shutdown.
 *
 * Contract under test (post-fix):
 *   1. Happy path (probe close 0): probe resolves true AND
 *      `jest.getTimerCount()` is 0 immediately after settle.
 *   2. Error path (proc emits 'error'): probe resolves false AND
 *      timer count is 0 immediately after settle.
 *   3. Timeout path (proc never closes): advancing fake timers
 *      past the watchdog kills the proc, resolves false with the
 *      preserved reason string, and exhausts the pending timer.
 *
 * Test surface: `__setProbeSpawnOverrideForTests` injects a fake
 * `ChildProcess` so the test never spawns python3. `jest.useFakeTimers`
 * captures the watchdog so `jest.getTimerCount()` is an honest signal.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  __setProbeSpawnOverrideForTests,
  __forceLoraProbeSpawnForTests,
  __resetCudaCacheForTests,
  __resetCapabilitySnapshotForTests,
  __isLoraStackAvailableForTests,
  __isCudaAvailableForTests,
} from '../heartbeat';

// Mock the docking module so any side-effect probe stays inert.
jest.mock('../../docking', () => ({
  isVinaAvailable: jest.fn().mockResolvedValue(false),
  __resetVinaCacheForTests: jest.fn(),
  runDocking: jest.fn(),
  assertBinariesAvailable: jest.fn(),
  parseVinaPdbqt: jest.fn(),
  DockingError: class DockingError extends Error {},
}));

interface FakeProc extends EventEmitter {
  kill: jest.Mock;
  stderr: EventEmitter;
}

function makeFakeProc(): FakeProc {
  const ee = new EventEmitter() as FakeProc;
  ee.kill = jest.fn();
  ee.stderr = new EventEmitter();
  return ee;
}

describe('Bug 23 — probe timer leak (isLoraStackAvailable)', () => {
  let fakeProc: FakeProc;

  beforeEach(() => {
    jest.useFakeTimers();
    __resetCapabilitySnapshotForTests();
    __forceLoraProbeSpawnForTests();
    fakeProc = makeFakeProc();
    __setProbeSpawnOverrideForTests(() => fakeProc as any);
  });

  afterEach(() => {
    __setProbeSpawnOverrideForTests(null);
    __resetCapabilitySnapshotForTests();
    jest.useRealTimers();
  });

  it('happy path — probe close 0 clears the watchdog (no pending timers)', async () => {
    const probePromise = __isLoraStackAvailableForTests();
    // The dynamic `import('node:child_process')` is sync-cached after the
    // first real import, but to be safe drain microtasks before checking
    // pending timer count (the setTimeout is queued inside the executor
    // which runs after `spawn` resolves).
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);

    // Emit success close — should clearTimeout the watchdog.
    fakeProc.emit('close', 0);
    const result = await probePromise;

    expect(result).toBe(true);
    expect(jest.getTimerCount()).toBe(0); // BUG 23 REGRESSION GUARD
    expect(fakeProc.kill).not.toHaveBeenCalled();
  });

  it('error path — proc error event clears the watchdog (no pending timers)', async () => {
    const probePromise = __isLoraStackAvailableForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);

    fakeProc.emit('error', new Error('spawn ENOENT'));
    const result = await probePromise;

    expect(result).toBe(false);
    expect(jest.getTimerCount()).toBe(0); // BUG 23 REGRESSION GUARD
    expect(fakeProc.kill).not.toHaveBeenCalled();
  });

  it('timeout path — advancing 60s kills proc, resolves false, no leftover timer', async () => {
    const probePromise = __isLoraStackAvailableForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);

    // Fire the watchdog.
    jest.advanceTimersByTime(60_000);
    const result = await probePromise;

    expect(result).toBe(false);
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
    // After watchdog fires + settle resolves, no pending timers remain.
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Bug 23 — probe timer leak (isCudaAvailable)', () => {
  let fakeProc: FakeProc;

  beforeEach(() => {
    jest.useFakeTimers();
    __resetCudaCacheForTests();
    fakeProc = makeFakeProc();
    __setProbeSpawnOverrideForTests(() => fakeProc as any);
  });

  afterEach(() => {
    __setProbeSpawnOverrideForTests(null);
    __resetCudaCacheForTests();
    jest.useRealTimers();
  });

  it('happy path — proc close 0 clears the watchdog (no pending timers)', async () => {
    const probePromise = __isCudaAvailableForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);

    fakeProc.emit('close', 0);
    const result = await probePromise;

    expect(result).toBe(true);
    expect(jest.getTimerCount()).toBe(0); // BUG 23 REGRESSION GUARD
    expect(fakeProc.kill).not.toHaveBeenCalled();
  });

  it('error path — proc error event clears the watchdog (no pending timers)', async () => {
    const probePromise = __isCudaAvailableForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);

    fakeProc.emit('error', new Error('spawn ENOENT'));
    const result = await probePromise;

    expect(result).toBe(false);
    expect(jest.getTimerCount()).toBe(0); // BUG 23 REGRESSION GUARD
    expect(fakeProc.kill).not.toHaveBeenCalled();
  });

  it('timeout path — advancing 30s kills proc, resolves false, no leftover timer', async () => {
    const probePromise = __isCudaAvailableForTests();
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(30_000);
    const result = await probePromise;

    expect(result).toBe(false);
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
