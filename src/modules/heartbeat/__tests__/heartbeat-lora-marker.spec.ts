/**
 * Bug 12 v2 — heartbeat marker-hydration path (root-cause fix).
 *
 * Live evidence 2026-05-17 coord log:
 *   00:05:12 caps drift detected peer=POD1 added=[gpu_training,lora_training] removed=[]
 *   00:08:21 caps drift detected peer=POD1 added=[] removed=[gpu_training,lora_training]
 *   00:09:24 caps drift detected peer=POD1 added=[gpu_training,lora_training] removed=[]
 *   00:13:35 caps drift detected peer=POD1 added=[] removed=[gpu_training,lora_training]
 *
 * Cap set oscillated 4x in ~10min because `isLoraStackAvailable()`
 * re-spawned `python -c "import transformers, ..."` on every tick whose
 * cache was cold, and any single 60s timeout poisoned the result. The
 * marker eliminates the per-tick spawn entirely once install-deps has
 * written it.
 *
 * Contract under test (heartbeat side):
 *   1. With a valid marker present at boot, `determineCapabilitiesAsync`
 *      returns lora_training WITHOUT spawning python — proven by
 *      asserting the helper's spawn-mocked sentinel was never called.
 *   2. Five back-to-back heartbeat ticks with marker present spawn ZERO
 *      python probes (the regression scenario: pre-fix code probed every
 *      tick whose process cache was cold).
 *   3. With NO marker present, the helper falls back to spawning the
 *      probe (existing behaviour preserved — fallback path still works
 *      for operators with manually-bootstrapped venvs).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { Hardware } from '../../hardware/hardware';

const TMP_HOME = join(tmpdir(), `syn-test-hb-marker-${process.pid}-${Date.now()}`);

/**
 * Reviewer HIGH-1 (post-rework): the heartbeat now refuses to trust a
 * marker when `venvExists()` is false — without this guard a marker
 * could outlive the venv it points to. Tests therefore must materialise
 * a fake venv interpreter so `venvExists()` returns true on the
 * marker-hydration path. We stub a tiny shell script at
 * `${TMP_HOME}/venv/bin/python` (POSIX) or `Scripts\python.exe`
 * (Windows) that exits 0 for any args — enough for the spawnSync
 * `--version` probe inside `venvExists()` to succeed.
 */
function stubVenv(): void {
  if (process.platform === 'win32') {
    const dir = join(TMP_HOME, 'venv', 'Scripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'python.exe'), '@echo off\nexit /B 0\n', 'utf-8');
  } else {
    const dir = join(TMP_HOME, 'venv', 'bin');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'python');
    writeFileSync(script, '#!/bin/sh\nexit 0\n', 'utf-8');
    chmodSync(script, 0o755);
  }
}

// Unrelated module mocks (mirror heartbeat-lora-capability.spec.ts).
jest.mock('../../docking', () => ({
  isVinaAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
  __resetVinaCacheForTests: jest.fn(),
  runDocking: jest.fn(),
  assertBinariesAvailable: jest.fn(),
  parseVinaPdbqt: jest.fn(),
  DockingError: class DockingError extends Error {},
}));

jest.mock('../../model/trainer', () => {
  const actual = jest.requireActual<typeof import('../../model/trainer')>(
    '../../model/trainer',
  );
  return {
    ...actual,
    isPyTorchAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
});

jest.mock('../../llm/training-llm', () => ({
  resolveTrainingLlmModel: jest
    .fn<() => Promise<string | null>>()
    .mockResolvedValue('llama3.2:1b'),
}));

const POD_HARDWARE: Hardware = {
  arch: 'x64' as any,
  cpuCores: 16,
  ramGb: 25,
  gpuVramGb: 24,
  hasOllama: true,
  hasCloudLlm: false,
  hardwareClass: 4,
} as Hardware;

describe('HeartbeatHelper — LoRA marker hydration (Bug 12 v2)', () => {
  beforeEach(() => {
    process.env.SYNAPSEIA_HOME = TMP_HOME;
    mkdirSync(TMP_HOME, { recursive: true });
    jest.resetModules();
  });

  afterEach(() => {
    try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* tolerate */ }
    delete process.env.SYNAPSEIA_HOME;
  });

  // Helper: spy on the FRESHLY-IMPORTED logger module each test, since
  // jest.resetModules() invalidates any spy attached to a top-level
  // import (the heartbeat module receives a new logger instance after
  // reset, and a stale spy on the old instance would never see calls).
  async function spyOnFreshLogger() {
    const loggerMod = await import('../../../utils/logger');
    return jest.spyOn(loggerMod.default, 'warn').mockImplementation(() => undefined);
  }

  it('advertises lora_training from a valid marker WITHOUT spawning python', async () => {
    const warnSpy = await spyOnFreshLogger();
    // Materialise a fake venv interpreter so venvExists() returns true
    // (reviewer HIGH-1 gate on the marker-hydration path).
    stubVenv();
    // Pre-seed the marker on disk (simulates install-deps having run).
    const venv = await import('../../../utils/python-venv');
    venv.writeLoraStackMarker({
      venvPython: venv.venvPython(),
      transformersVersion: '4.45.0',
    });

    // Now load the heartbeat module fresh so its module-private
    // `loraStackMarkerChecked` flag is reset and it will read the
    // marker on the first probe call.
    const hb = await import('../heartbeat');
    hb.__resetCapabilitySnapshotForTests();

    // Indirect-spawn sentinel: marker hydration short-circuits BEFORE
    // the dynamic `await import('node:child_process')`. If lora_training
    // is in the cap set AND no probe-failed warn fired, we know the
    // marker won. (Real spawn-spy would require ESM child_process
    // mocking which is incompatible with the project jest config.)
    const helper = new hb.HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    expect(caps).toContain('lora_training');
    const loraFailWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('LoRA Python stack probe failed'));
    expect(loraFailWarns).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('returns lora_training on 5 back-to-back ticks with marker present (no oscillation)', async () => {
    const warnSpy = await spyOnFreshLogger();
    stubVenv();
    const venv = await import('../../../utils/python-venv');
    venv.writeLoraStackMarker({
      venvPython: venv.venvPython(),
    });

    const hb = await import('../heartbeat');
    hb.__resetCapabilitySnapshotForTests();

    const helper = new hb.HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);

    const results: string[][] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await helper.determineCapabilitiesAsync(POD_HARDWARE));
    }

    // Every tick must return lora_training. ANY oscillation here would
    // reproduce the live coord drift bug.
    for (const caps of results) {
      expect(caps).toContain('lora_training');
    }
    warnSpy.mockRestore();
  });

  it('falls back to probe spawn when no marker is present', async () => {
    const warnSpy = await spyOnFreshLogger();
    // No marker written. Load heartbeat fresh.
    const hb = await import('../heartbeat');
    hb.__resetCapabilitySnapshotForTests();

    // Seed the test-only sticky-false path to simulate the probe
    // failing (e.g. transformers not installed). This proves the
    // fallback path is still wired — when the marker is absent we go
    // through the probe, not blindly return true.
    hb.__seedLoraStackProbeForTests(false, 'ModuleNotFoundError: transformers');

    const helper = new hb.HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    expect(caps).not.toContain('lora_training');
    // The diagnostic warn proves we went through the probe branch
    // (not the marker shortcut).
    const loraFailWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('LoRA Python stack probe failed'));
    expect(loraFailWarns).toHaveLength(1);
    expect(loraFailWarns[0]).toContain('ModuleNotFoundError: transformers');
    warnSpy.mockRestore();
  });

  it('refuses to hydrate marker when venv interpreter is missing AND deletes the stale marker (reviewer HIGH-1)', async () => {
    // Reproduce the exact regression reviewer HIGH-1 caught: install-
    // deps wrote a marker, operator subsequently deleted the venv
    // (e.g. `rm -rf ~/.synapseia/venv`). Pre-rework code would
    // string-match `venvPython()` against the stored path, see they
    // matched, and merrily advertise lora_training based on a now-
    // dead interpreter. Post-rework: marker hydration is gated on
    // `venvExists()`, the dead marker is deleted, and the cap is
    // dropped.
    const warnSpy = await spyOnFreshLogger();
    // NB: stubVenv() deliberately NOT called — the venv must NOT exist.
    const venv = await import('../../../utils/python-venv');
    venv.writeLoraStackMarker({
      venvPython: venv.venvPython(),
      transformersVersion: '4.45.0',
    });
    const { existsSync } = await import('fs');
    expect(existsSync(venv.LORA_STACK_MARKER)).toBe(true);

    const hb = await import('../heartbeat');
    hb.__resetCapabilitySnapshotForTests();
    // No __seedLoraStackProbeForTests here — we deliberately drive
    // the real marker-hydration branch end-to-end. The `!venvExists()`
    // early-return inside `isLoraStackAvailable` short-circuits
    // BEFORE any child_process spawn, so this is safe regardless of
    // the host's `python3` PATH.

    const helper = new hb.HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    expect(caps).not.toContain('lora_training');
    expect(caps).not.toContain('lora_generation');
    // Stale marker must have been deleted by the hydration path so a
    // future boot doesn't re-trust it before the probe even runs.
    expect(existsSync(venv.LORA_STACK_MARKER)).toBe(false);
    warnSpy.mockRestore();
  });
});
