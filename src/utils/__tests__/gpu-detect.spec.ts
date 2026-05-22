/**
 * Tests for the shared CUDA detection helper (utils/gpu-detect.ts) — the
 * SINGLE SOURCE OF TRUTH consumed by heartbeat capability advertising and
 * the LoRA trainer/validator `hasGpu()` precheck.
 *
 * The probe spawns `python3 -c "import torch; assert torch.cuda.is_available()"`.
 * We inject a fake child process via the test-only spawn override so no real
 * python is launched. Coverage: positive cache, false re-probe, error/timeout
 * paths, and the seed/reset test seams.
 */

import { EventEmitter } from 'events';
import {
  detectCudaAvailable,
  __setCudaProbeSpawnOverrideForTests,
  __resetCudaCacheForTests,
  __seedCudaCacheForTests,
} from '../gpu-detect';

interface FakeProc extends EventEmitter {
  kill: jest.Mock;
}

function makeFakeProc(): FakeProc {
  const ee = new EventEmitter() as FakeProc;
  ee.kill = jest.fn();
  return ee;
}

describe('detectCudaAvailable — shared CUDA probe', () => {
  let fakeProc: FakeProc;
  let spawnCalls: number;

  beforeEach(() => {
    jest.useFakeTimers();
    __resetCudaCacheForTests();
    spawnCalls = 0;
    fakeProc = makeFakeProc();
    __setCudaProbeSpawnOverrideForTests(() => {
      spawnCalls += 1;
      return fakeProc as any;
    });
  });

  afterEach(() => {
    __setCudaProbeSpawnOverrideForTests(null);
    __resetCudaCacheForTests();
    jest.useRealTimers();
  });

  it('returns true when the probe exits 0 and positive-caches the result', async () => {
    const p1 = detectCudaAvailable();
    await Promise.resolve();
    await Promise.resolve();
    fakeProc.emit('close', 0);
    expect(await p1).toBe(true);
    expect(spawnCalls).toBe(1);
    expect(jest.getTimerCount()).toBe(0); // watchdog cleared on close

    // Second call: positive cache → no second spawn.
    expect(await detectCudaAvailable()).toBe(true);
    expect(spawnCalls).toBe(1);
  });

  it('returns false on non-zero exit and does NOT cache (re-probes next call)', async () => {
    const p1 = detectCudaAvailable();
    await Promise.resolve();
    await Promise.resolve();
    fakeProc.emit('close', 1);
    expect(await p1).toBe(false);
    expect(spawnCalls).toBe(1);

    // Not cached → a fresh probe runs (e.g. a late driver could flip it true).
    fakeProc = makeFakeProc();
    const p2 = detectCudaAvailable();
    await Promise.resolve();
    await Promise.resolve();
    fakeProc.emit('close', 1);
    expect(await p2).toBe(false);
    expect(spawnCalls).toBe(2);
  });

  it('returns false on spawn error and clears the watchdog', async () => {
    const p = detectCudaAvailable();
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);
    fakeProc.emit('error', new Error('spawn ENOENT'));
    expect(await p).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(fakeProc.kill).not.toHaveBeenCalled();
  });

  it('times out after 30s → kills proc, resolves false, no leftover timer', async () => {
    const p = detectCudaAvailable();
    await Promise.resolve();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(30_000);
    expect(await p).toBe(false);
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('__seedCudaCacheForTests(true) short-circuits without spawning', async () => {
    __seedCudaCacheForTests(true);
    expect(await detectCudaAvailable()).toBe(true);
    expect(spawnCalls).toBe(0);
  });
});
