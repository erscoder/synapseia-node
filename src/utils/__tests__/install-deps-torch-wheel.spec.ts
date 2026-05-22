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

// Inject a fixed spec into every legacy assertion so the wheel-CHOICE
// branches stay deterministic (without it, pickTorchWheel would spawn the
// real venv python to detect the Python minor version). The 3.12 spec is
// the proven legacy default — it preserves the original cu121 assertions.
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

  it('Linux + NVIDIA detected → cu121 wheel', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => true,
      spec: SPEC_312,
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
      spec: SPEC_312,
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.hasNvidia).toBe(false);
  });

  it('Windows + NVIDIA detected → cu121 wheel', () => {
    const choice = pickTorchWheel({
      platform: 'win32',
      nvidiaProbeFn: () => true,
      spec: SPEC_312,
    });
    expect(choice.label).toBe('cu121');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu121');
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

  // ── Python-version-aware wheel selection (2026-05-22) ───────────────
  // The torch version + NVIDIA index must follow the venv Python minor.
  // A cp313 NVIDIA host MUST get torch 2.6.0 / cu124 (the cu121 index has
  // no cp313 wheel → the old hard pin 404'd and bricked training).

  it('Python 3.13 + Linux NVIDIA → torch 2.6.0 from cu124 index', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => true,
      spec: selectTorchSpec(13),
    });
    expect(choice.label).toBe('cu124');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cu124');
    expect(choice.torchVersion).toBe('2.6.0');
    expect(choice.hasNvidia).toBe(true);
    expect(choice.bestEffort).toBe(false);
    expect(choice.reason).toMatch(/2\.6\.0/);
    expect(choice.reason).toMatch(/cu124/);
  });

  it('Python 3.13 + macOS → mps/default but torch version is 2.6.0', () => {
    const choice = pickTorchWheel({
      platform: 'darwin',
      nvidiaProbeFn: () => false,
      spec: selectTorchSpec(13),
    });
    expect(choice.label).toBe('mps/default');
    expect(choice.indexUrl).toBeNull();
    expect(choice.torchVersion).toBe('2.6.0');
  });

  it('Python 3.13 + CPU Linux → cpu wheel but torch version is 2.6.0', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => false,
      spec: selectTorchSpec(13),
    });
    expect(choice.label).toBe('cpu');
    expect(choice.indexUrl).toBe('https://download.pytorch.org/whl/cpu');
    expect(choice.torchVersion).toBe('2.6.0');
  });

  it('Python 3.14 (best-effort) + Linux NVIDIA → 2.6.0/cu124 attempt, bestEffort=true', () => {
    const choice = pickTorchWheel({
      platform: 'linux',
      nvidiaProbeFn: () => true,
      spec: selectTorchSpec(14),
    });
    expect(choice.label).toBe('cu124');
    expect(choice.torchVersion).toBe('2.6.0');
    expect(choice.bestEffort).toBe(true);
  });
});

describe('install-deps selectTorchSpec (Python-version matrix, 2026-05-22)', () => {
  it.each([
    [10, '2.5.1', 'cu121', false],
    [11, '2.5.1', 'cu121', false],
    [12, '2.5.1', 'cu121', false],
  ])('Python 3.%i → torch %s / %s, not best-effort (proven legacy)', (minor, ver, label, best) => {
    const spec = selectTorchSpec(minor as number);
    expect(spec.torchVersion).toBe(ver);
    expect(spec.nvidiaLabel).toBe(label);
    expect(spec.nvidiaIndexUrl).toBe(`https://download.pytorch.org/whl/${label}`);
    expect(spec.bestEffort).toBe(best);
  });

  it('Python 3.13 → torch 2.6.0 / cu124, not best-effort (VERIFIED on A5000 pod)', () => {
    const spec = selectTorchSpec(13);
    expect(spec.torchVersion).toBe('2.6.0');
    expect(spec.nvidiaLabel).toBe('cu124');
    expect(spec.nvidiaIndexUrl).toBe('https://download.pytorch.org/whl/cu124');
    expect(spec.bestEffort).toBe(false);
  });

  it('Python 3.14 → torch 2.6.0 / cu124 ATTEMPT, best-effort=true (no pinned cp314 wheel exists)', () => {
    // cp314 has no torch 2.6.0 wheel anywhere; the cpu index jumps to
    // torch 2.9+ for cp314. We attempt the cp313 spec but flag
    // best-effort so an install failure is non-fatal and the node still
    // boots without torch.
    const spec = selectTorchSpec(14);
    expect(spec.torchVersion).toBe('2.6.0');
    expect(spec.nvidiaLabel).toBe('cu124');
    expect(spec.bestEffort).toBe(true);
  });

  it('Python 3.15+ → still best-effort (no regression to a hard-fail)', () => {
    const spec = selectTorchSpec(15);
    expect(spec.bestEffort).toBe(true);
  });
});
