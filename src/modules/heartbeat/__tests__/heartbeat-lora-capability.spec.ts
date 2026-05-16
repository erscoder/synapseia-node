/**
 * Bug 12 (HIGH) — LoRA training capability advertisement.
 *
 * Live evidence (2026-05-16): coordinator-side LORA_TRAINING round
 * `tr_lora_training_1778961600578_e3ee8781` opened with 5000 SYN pool
 * and never matched any participants. Operator pods POD1 (A5000 24GB,
 * 25GB RAM) and POD2 (RTX4000 Ada 20GB, 50GB RAM) both have the LoRA
 * Python stack installed (`install-deps.ts` phase 3 emitted
 * `[↷] LoRA training stack already installed` at boot). Yet the
 * coord-side capability-drift log showed both pods self-reporting
 * only 7 caps with `lora_training` ABSENT.
 *
 * The original probe (`isLoraStackAvailable`) ran
 * `python -c "import transformers, peft, datasets, safetensors,
 * accelerate"` with `{ stdio: ['ignore', 'pipe', 'pipe'] }` but
 * DISCARDED stderr — operators had no signal as to whether the
 * failure was (a) "transformers not in venv" (re-run install-deps),
 * (b) "import timed out" (raise timeout / wait next heartbeat), or
 * (c) "ImportError: cannot import name X from torch" (torch wheel
 * ≠ transformers expectations). On top of that the diagnostic warn
 * at heartbeat caller was gated on
 * `freeMB >= LORA_TRAINING_MEM_FLOOR_MB`, silently suppressing the
 * one signal that would have explained the missing cap.
 *
 * Contract under test:
 *   1. `lora_training` IS advertised when probe succeeds AND
 *      `hasCapacity` (gpuVramGb > 0 || ramGb >= 16) is true.
 *   2. `lora_training` is NOT advertised when probe fails.
 *   3. When the probe fails (and the node otherwise qualifies), the
 *      heartbeat emits a SINGLE diagnostic warn including the
 *      captured reason — gated only on process-lifetime once-only,
 *      NOT on memory floor.
 *   4. The warn is suppressed on subsequent heartbeat cycles
 *      (loraStackWarnEmitted once-only) to avoid the 60s log spam
 *      that hotfix 0.8.55 already targeted.
 *   5. `lora_training` is omitted when `hasCapacity` is false (small
 *      Docker node, no GPU, < 16 GB RAM) regardless of probe result.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import logger from '../../../utils/logger';
import {
  HeartbeatHelper,
  __resetCapabilitySnapshotForTests,
  __seedLoraStackProbeForTests,
} from '../heartbeat';
import type { Hardware } from '../../hardware/hardware';

// Mock the docking module so the unrelated Vina probe doesn't spawn brew/which.
jest.mock('../../docking', () => ({
  isVinaAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
  __resetVinaCacheForTests: jest.fn(),
  runDocking: jest.fn(),
  assertBinariesAvailable: jest.fn(),
  parseVinaPdbqt: jest.fn(),
  DockingError: class DockingError extends Error {},
}));

// Mock PyTorch + LLM probes so cpu_training stays in the cap set without
// spawning real python3 / hitting Ollama.
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
  ramGb: 25,          // matches POD1 live snapshot
  gpuVramGb: 24,      // A5000
  hasOllama: true,
  hasCloudLlm: false,
  hardwareClass: 4,
} as Hardware;

const SMALL_DOCKER_HARDWARE: Hardware = {
  arch: 'arm64' as any,
  cpuCores: 4,
  ramGb: 8,
  gpuVramGb: 0,
  hasOllama: false,
  hasCloudLlm: false,
  hardwareClass: 0,
} as Hardware;

describe('HeartbeatHelper.determineCapabilitiesAsync — lora_training capability (Bug 12)', () => {
  let helper: HeartbeatHelper;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  beforeEach(() => {
    __resetCapabilitySnapshotForTests();
    helper = new HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetCapabilitySnapshotForTests();
    warnSpy.mockRestore();
  });

  it("advertises 'lora_training' when probe succeeds and hardware qualifies (POD live scenario)", async () => {
    __seedLoraStackProbeForTests(true);

    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    expect(caps).toContain('lora_training');
    // Sanity: the rest of the POD cap set is also present — proves the
    // success branch didn't accidentally short-circuit other gates.
    expect(caps).toContain('cpu_training');
    expect(caps).toContain('gpu_training');
    expect(caps).toContain('gpu_inference');
  });

  it("omits 'lora_training' when probe fails AND emits a single diagnostic warn including the captured reason", async () => {
    __seedLoraStackProbeForTests(
      false,
      "ModuleNotFoundError: No module named 'transformers'",
    );

    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    expect(caps).not.toContain('lora_training');
    expect(caps).not.toContain('lora_generation'); // gated on lora_training

    // Exactly one heartbeat-level warn for the LoRA probe — message must
    // surface the captured reason so operators can triage without SSH.
    const loraWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('LoRA Python stack probe failed'));
    expect(loraWarns).toHaveLength(1);
    expect(loraWarns[0]).toContain(
      "ModuleNotFoundError: No module named 'transformers'",
    );
  });

  it('suppresses the diagnostic warn on subsequent heartbeats (once-only throttle)', async () => {
    __seedLoraStackProbeForTests(false, 'probe timed out after 60s');

    await helper.determineCapabilitiesAsync(POD_HARDWARE);
    await helper.determineCapabilitiesAsync(POD_HARDWARE);
    await helper.determineCapabilitiesAsync(POD_HARDWARE);

    const loraWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('LoRA Python stack probe failed'));
    // ONE warn across three heartbeats — once-only per process lifetime.
    // Without this throttle the warn would fire every 60s on every node
    // that boots without the stack (live hotfix 0.8.55 regression).
    expect(loraWarns).toHaveLength(1);
  });

  it('does NOT emit the LoRA warn on hardware that does not qualify (small Docker node)', async () => {
    __seedLoraStackProbeForTests(false, 'whatever');

    const caps = await helper.determineCapabilitiesAsync(SMALL_DOCKER_HARDWARE);

    expect(caps).not.toContain('lora_training');
    // The warn is gated on `hasCapacity` — telling a small Tier-0 node to
    // install ~500 MB of LoRA deps is noise. Hardware below threshold
    // should never receive the diagnostic.
    const loraWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('LoRA Python stack probe failed'));
    expect(loraWarns).toHaveLength(0);
  });

  it('emits the diagnostic warn regardless of memory pressure (regression: pre-fix gate hid the failure)', async () => {
    // Pre-fix code skipped the warn whenever `freeMB < LORA_TRAINING_MEM_FLOOR_MB`.
    // That gate silently buried the failure on memory-pressured hosts —
    // exactly the hosts most likely to drop a cap and confuse operators.
    // The post-fix warn must fire purely on (qualifies + probe-failed +
    // not-yet-warned), with no memory floor coupling.
    //
    // We can't easily spy on os.freemem under ESM jest, but we can
    // assert behaviour: with the seed below the warn must fire on the
    // POD hardware that DOES qualify, full stop.
    __seedLoraStackProbeForTests(
      false,
      'ImportError: cannot import name X from torch',
    );

    await helper.determineCapabilitiesAsync(POD_HARDWARE);

    const loraWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('LoRA Python stack probe failed'));
    expect(loraWarns).toHaveLength(1);
    expect(loraWarns[0]).toContain(
      'ImportError: cannot import name X from torch',
    );
    // Re-install hint included so operator knows the venv path —
    // not "pip3" (which install-deps deprecated for venvPip).
    expect(loraWarns[0]).toMatch(/python.*-m pip install transformers/);
  });
});
