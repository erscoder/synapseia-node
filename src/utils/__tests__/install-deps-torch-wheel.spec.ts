/**
 * install-deps — `pickTorchWheel` spec (Slice 16).
 *
 * Pure-function spec: drives every platform × NVIDIA-probe branch of
 * the wheel selector. Covers the root-cause regression that the
 * pre-slice code hardcoded `whl/cpu` and broke DiLoCo on every
 * NVIDIA pod by stripping CUDA bindings from torch.
 *
 * No subprocesses are spawned here — the helper accepts injected
 * `platform` + `nvidiaProbeFn` so tests are deterministic and fast.
 *
 * Per P24 discipline (fail-CLOSED on probe error): a probe that
 * throws must be treated as "no NVIDIA", not as a crash propagated
 * out of install-deps.
 */

import { describe, it, expect } from '@jest/globals';
import { pickTorchWheel } from '../install-deps';

describe('install-deps pickTorchWheel (Slice 16)', () => {
  it('macOS + no NVIDIA → mps/default wheel, no --index-url', () => {
    const choice = pickTorchWheel({
      platform: 'darwin',
      nvidiaProbeFn: () => false,
    });
    expect(choice.label).toBe('mps/default');
    expect(choice.indexUrl).toBeNull();
    expect(choice.hasNvidia).toBe(false);
    expect(choice.reason).toMatch(/macOS/i);
  });

  it('macOS even if NVIDIA probe returns true → still mps/default (CUDA not supported on Mac)', () => {
    // Defensive: macOS hosts cannot have NVIDIA CUDA support since
    // ~2019, so the wheel choice must override the probe result.
    const choice = pickTorchWheel({
      platform: 'darwin',
      nvidiaProbeFn: () => true,
    });
    expect(choice.label).toBe('mps/default');
    expect(choice.indexUrl).toBeNull();
    expect(choice.hasNvidia).toBe(false);
  });

  it('Linux + NVIDIA detected → cu121 wheel', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => true,
    });
    expect(choice.label).toBe('cu121');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu121');
    expect(choice.hasNvidia).toBe(true);
    expect(choice.reason).toMatch(/NVIDIA/i);
  });

  it('Linux + no NVIDIA → cpu wheel', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => false,
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.hasNvidia).toBe(false);
  });

  it('Windows + NVIDIA detected → cu121 wheel', () => {
    const choice = pickTorchWheel({
      platform: 'win32',
      nvidiaProbeFn: () => true,
    });
    expect(choice.label).toBe('cu121');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu121');
    expect(choice.hasNvidia).toBe(true);
  });

  it('Windows + no NVIDIA → cpu wheel', () => {
    const choice = pickTorchWheel({
      platform: 'win32',
      nvidiaProbeFn: () => false,
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.hasNvidia).toBe(false);
  });

  it('nvidiaProbeFn throws on Linux → fail-CLOSED to cpu wheel (P24)', () => {
    // Per P24: an unexpected throw from the probe must not crash
    // install-deps. The safe fallback is the cpu wheel — wrong but
    // harmless — rather than aborting node boot.
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => {
        throw new Error('nvidia-smi segfault simulated');
      },
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.hasNvidia).toBe(false);
  });

  it('nvidiaProbeFn throws on Windows → fail-CLOSED to cpu wheel', () => {
    const choice = pickTorchWheel({
      platform: 'win32',
      nvidiaProbeFn: () => {
        throw new Error('access denied');
      },
    });
    expect(choice.label).toBe('cpu');
    expect(choice.hasNvidia).toBe(false);
  });

  it('Unsupported platform (freebsd) → cpu wheel with explanatory reason', () => {
    const choice = pickTorchWheel({
      platform: 'freebsd',
      nvidiaProbeFn: () => false,
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.reason).toMatch(/freebsd|unsupported/i);
  });

  it('reason string is always populated', () => {
    // Telemetry / operator-debugging contract: every choice must
    // include a non-empty reason so the install log explains WHY a
    // particular wheel was picked.
    const choices = [
      pickTorchWheel({ platform: 'darwin', nvidiaProbeFn: () => false }),
      pickTorchWheel({ platform: 'linux', nvidiaProbeFn: () => true }),
      pickTorchWheel({ platform: 'linux', nvidiaProbeFn: () => false }),
      pickTorchWheel({ platform: 'win32', nvidiaProbeFn: () => true }),
      pickTorchWheel({ platform: 'win32', nvidiaProbeFn: () => false }),
    ];
    for (const c of choices) {
      expect(typeof c.reason).toBe('string');
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });
});
