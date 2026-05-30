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
import { pickTorchWheel, selectTorchSpec, type TorchSpec } from '../install-deps';

// Inject a fixed spec into every wheel-CHOICE assertion so the branches
// stay deterministic (without it, pickTorchWheel would spawn the real
// venv python to detect the Python minor version). 3.12 now resolves to
// torch 2.9.1 / cu128 — the previous 2.6.0 / cu124 pin AGED OUT of PyPI
// (default index dropped 2.6.0; cu124 never carried a cp314 wheel).
const SPEC_312: TorchSpec = selectTorchSpec(12);

describe('install-deps pickTorchWheel (Slice 16)', () => {
  it('macOS + no NVIDIA → mps/default wheel, no --index-url', () => {
    const choice = pickTorchWheel({
      platform: 'darwin',
      nvidiaProbeFn: () => false,
      spec: SPEC_312,
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
      spec: SPEC_312,
    });
    expect(choice.label).toBe('mps/default');
    expect(choice.indexUrl).toBeNull();
    expect(choice.hasNvidia).toBe(false);
  });

  it('Linux + NVIDIA detected → cu128 wheel', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => true,
      spec: SPEC_312,
    });
    expect(choice.label).toBe('cu128');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu128');
    expect(choice.hasNvidia).toBe(true);
    expect(choice.reason).toMatch(/NVIDIA/i);
  });

  it('Linux + no NVIDIA → cpu wheel', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => false,
      spec: SPEC_312,
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.hasNvidia).toBe(false);
  });

  it('Windows + NVIDIA detected → cu128 wheel', () => {
    const choice = pickTorchWheel({
      platform: 'win32',
      nvidiaProbeFn: () => true,
      spec: SPEC_312,
    });
    expect(choice.label).toBe('cu128');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu128');
    expect(choice.hasNvidia).toBe(true);
  });

  it('Windows + no NVIDIA → cpu wheel', () => {
    const choice = pickTorchWheel({
      platform: 'win32',
      nvidiaProbeFn: () => false,
      spec: SPEC_312,
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
      spec: SPEC_312,
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
      spec: SPEC_312,
    });
    expect(choice.label).toBe('cpu');
    expect(choice.hasNvidia).toBe(false);
  });

  it('Unsupported platform (freebsd) → cpu wheel with explanatory reason', () => {
    const choice = pickTorchWheel({
      platform: 'freebsd',
      nvidiaProbeFn: () => false,
      spec: SPEC_312,
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
      pickTorchWheel({ platform: 'darwin', nvidiaProbeFn: () => false, spec: SPEC_312 }),
      pickTorchWheel({ platform: 'linux', nvidiaProbeFn: () => true, spec: SPEC_312 }),
      pickTorchWheel({ platform: 'linux', nvidiaProbeFn: () => false, spec: SPEC_312 }),
      pickTorchWheel({ platform: 'win32', nvidiaProbeFn: () => true, spec: SPEC_312 }),
      pickTorchWheel({ platform: 'win32', nvidiaProbeFn: () => false, spec: SPEC_312 }),
    ];
    for (const c of choices) {
      expect(typeof c.reason).toBe('string');
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  // ── Python-version-aware wheel selection (2026-05-22, repinned 05-30) ─
  // The torch version + NVIDIA index must follow the venv Python minor.
  // Every supported host (cp310-cp314) MUST get torch 2.9.1 / cu128:
  // the previous 2.6.0 / cu124 pin aged out of PyPI and never had a cp314
  // wheel, so Python-3.14 nodes (node-kike) booted without torch.

  it('Python 3.13 + Linux NVIDIA → torch 2.9.1 from cu128 index', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => true,
      spec: selectTorchSpec(13),
    });
    expect(choice.label).toBe('cu128');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu128');
    expect(choice.torchVersion).toBe('2.9.1');
    expect(choice.hasNvidia).toBe(true);
    expect(choice.bestEffort).toBe(false);
    expect(choice.reason).toMatch(/2\.9\.1/);
    expect(choice.reason).toMatch(/cu128/);
  });

  it('Python 3.13 + macOS → mps/default but torch version is 2.9.1', () => {
    const choice = pickTorchWheel({
      platform: 'darwin',
      nvidiaProbeFn: () => false,
      spec: selectTorchSpec(13),
    });
    expect(choice.label).toBe('mps/default');
    expect(choice.indexUrl).toBeNull();
    expect(choice.torchVersion).toBe('2.9.1');
  });

  it('Python 3.13 + CPU Linux → cpu wheel but torch version is 2.9.1', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => false,
      spec: selectTorchSpec(13),
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.torchVersion).toBe('2.9.1');
  });

  // REGRESSION (node-kike, 2026-05-30): cp314 must resolve to an AVAILABLE
  // wheel and NO LONGER be best-effort. torch 2.9.1 ships real cp314
  // wheels on the default/cpu index AND cu128, so the install no longer
  // 404s and the node keeps its pytorch/DiLoCo training caps. It must
  // NEVER resolve back to a yanked 2.5.1 / 2.6.0.
  it('Python 3.14 (cp314) + Linux NVIDIA → 2.9.1/cu128, NOT best-effort (node-kike fix)', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => true,
      spec: selectTorchSpec(14),
    });
    expect(choice.label).toBe('cu128');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu128');
    expect(choice.torchVersion).toBe('2.9.1');
    expect(choice.bestEffort).toBe(false);
    // Never a yanked version.
    expect(choice.torchVersion).not.toBe('2.5.1');
    expect(choice.torchVersion).not.toBe('2.6.0');
  });

  it('Python 3.14 (cp314) + macOS MPS → 2.9.1 default wheel, NOT best-effort (node-kike default path)', () => {
    const choice = pickTorchWheel({
      platform: 'darwin',
      nvidiaProbeFn: () => false,
      spec: selectTorchSpec(14),
    });
    expect(choice.label).toBe('mps/default');
    expect(choice.indexUrl).toBeNull();
    expect(choice.torchVersion).toBe('2.9.1');
    expect(choice.bestEffort).toBe(false);
    expect(choice.torchVersion).not.toBe('2.6.0');
  });
});

describe('install-deps selectTorchSpec (Python-version matrix, repinned 2026-05-30)', () => {
  // The 2.6.0 / cu124 pin aged out of PyPI (default index dropped 2.6.0;
  // cu124 never carried a cp314 wheel). All of 3.10-3.14 now resolve to
  // torch 2.9.1 / cu128 — the oldest stable still served by the default
  // index, with REAL cp314 wheels on default/cpu AND cu128. None may ever
  // resolve back to the yanked 2.5.1 / 2.6.0.
  it.each([
    [10, '2.9.1', 'cu128', false],
    [11, '2.9.1', 'cu128', false],
    [12, '2.9.1', 'cu128', false],
    [13, '2.9.1', 'cu128', false],
    [14, '2.9.1', 'cu128', false], // cp314 — node-kike fix, no longer best-effort
  ])('Python 3.%i → torch %s / %s, not best-effort', (minor, ver, label, best) => {
    const spec = selectTorchSpec(minor as number);
    expect(spec.torchVersion).toBe(ver);
    expect(spec.nvidiaLabel).toBe(label);
    expect(spec.nvidiaIndexUrl).toBe(`https://download.pytorch.org/whl/${label}`);
    expect(spec.bestEffort).toBe(best);
    // Regression guard: never a version that has aged out of PyPI.
    expect(spec.torchVersion).not.toBe('2.5.1');
    expect(spec.torchVersion).not.toBe('2.6.0');
  });

  it('Python 3.14 (cp314) → torch 2.9.1 / cu128, NOT best-effort (node-kike regression)', () => {
    // The headline node-kike fix: cp314 has REAL 2.9.1 wheels (default/cpu
    // + cu128), so the install no longer 404s on a yanked pin and the node
    // keeps its pytorch/DiLoCo training caps.
    const spec = selectTorchSpec(14);
    expect(spec.torchVersion).toBe('2.9.1');
    expect(spec.nvidiaLabel).toBe('cu128');
    expect(spec.nvidiaIndexUrl).toBe('https://download.pytorch.org/whl/cu128');
    expect(spec.bestEffort).toBe(false);
  });

  it('Python 3.15+ → still best-effort (no regression to a hard-fail on a future interpreter)', () => {
    const spec = selectTorchSpec(15);
    expect(spec.torchVersion).toBe('2.9.1');
    expect(spec.nvidiaLabel).toBe('cu128');
    expect(spec.bestEffort).toBe(true);
  });
});
