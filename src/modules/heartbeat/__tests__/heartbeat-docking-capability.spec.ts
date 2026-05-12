/**
 * Docking capability advertisement — closes the coord/node mismatch
 * where the coordinator's `DockingDispatchCron` skip-gates opening new
 * MOLECULAR_DOCKING pairs unless ≥1 online node advertises the
 * `docking` capability (`DockingDispatchCron.ts:130-141`), but the node
 * heartbeat builder never pushed it.
 *
 * Contract under test:
 *   - When Vina + Open Babel are detected on the host (`isVinaAvailable`
 *     resolves true), the announced capability set MUST include
 *     `'docking'`.
 *   - When detection fails (binaries absent / unusable), `'docking'`
 *     MUST be absent. Existing capabilities (cpu_training, cpu_inference,
 *     etc.) are unaffected.
 *
 * The detector function itself is exercised in
 * `modules/docking/__tests__/vina-availability.spec.ts`; here we mock
 * it to drive both branches of the heartbeat builder deterministically.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock the docking module BEFORE importing the heartbeat module under
// test. Jest hoists `jest.mock` to the top of the file, but the mock
// factory needs to be defined inline (no out-of-scope captures) for the
// hoisting to be safe.
jest.mock('../../docking', () => ({
  isVinaAvailable: jest.fn<() => Promise<boolean>>(),
  __resetVinaCacheForTests: jest.fn(),
  // Pass-through stubs for the other re-exports — the heartbeat module
  // only imports `isVinaAvailable`, but other consumers of `../docking`
  // (e.g. work-order coordinator) may load this module during test
  // discovery. Keeping the surface complete avoids TypeError on import.
  runDocking: jest.fn(),
  assertBinariesAvailable: jest.fn(),
  parseVinaPdbqt: jest.fn(),
  DockingError: class DockingError extends Error {},
}));

// Mock isPyTorchAvailable + resolveTrainingLlmModel so we don't actually
// spawn python3 / probe Ollama during the test. We don't care about
// cpu_training in these assertions, only docking.
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

import { HeartbeatHelper } from '../heartbeat';
import { isVinaAvailable } from '../../docking';
import type { Hardware } from '../../hardware/hardware';

const mockedIsVinaAvailable = isVinaAvailable as jest.MockedFunction<typeof isVinaAvailable>;

const BASELINE_HARDWARE: Hardware = {
  arch: 'arm64' as any,
  cpuCores: 8,
  ramGb: 16,
  gpuVramGb: 0,
  hasOllama: false,
  hasCloudLlm: false,
  hardwareClass: 1,
} as Hardware;

describe('HeartbeatHelper.determineCapabilitiesAsync — docking capability', () => {
  let helper: HeartbeatHelper;

  beforeEach(() => {
    helper = new HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    mockedIsVinaAvailable.mockReset();
  });

  it("includes 'docking' in capabilities when Vina is detected", async () => {
    mockedIsVinaAvailable.mockResolvedValue(true);

    const caps = await helper.determineCapabilitiesAsync(BASELINE_HARDWARE);

    expect(caps).toContain('docking');
    // sanity: detector was actually consulted
    expect(mockedIsVinaAvailable).toHaveBeenCalledTimes(1);
  });

  it("omits 'docking' when Vina is NOT detected", async () => {
    mockedIsVinaAvailable.mockResolvedValue(false);

    const caps = await helper.determineCapabilitiesAsync(BASELINE_HARDWARE);

    expect(caps).not.toContain('docking');
    // Other always-on caps unaffected — proves we only stripped docking,
    // not the rest of the set.
    expect(caps).toContain('cpu_inference');
    expect(mockedIsVinaAvailable).toHaveBeenCalledTimes(1);
  });

  it("omits 'docking' when the detector throws (non-fatal)", async () => {
    mockedIsVinaAvailable.mockRejectedValue(new Error('spawn failed'));

    const caps = await helper.determineCapabilitiesAsync(BASELINE_HARDWARE);

    expect(caps).not.toContain('docking');
    // Heartbeat must NOT propagate the error — the rest of the cap set
    // is still returned.
    expect(caps).toContain('cpu_inference');
  });
});
