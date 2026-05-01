/**
 * Bug G1 — Memory-pressure capability gating in HeartbeatHelper.
 *
 * Verifies that when free RAM is below TRAINING_MEM_FLOOR_MB, the
 * announced capability list strips training-class entries for that
 * cycle, then restores them automatically once memory recovers.
 *
 * The `info` log fires only on transitions, never per-cycle.
 *
 * Memory readings are injected via the `freeMBOverride` parameter on
 * `applyMemoryPressureFilter`. We don't spy on `os.freemem` because the
 * imported `os` namespace is frozen under ESM-mode jest.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import logger from '../../../utils/logger';
import { TRAINING_MEM_FLOOR_MB } from '../../model/trainer';
import { HeartbeatHelper, __resetCapabilitySnapshotForTests } from '../heartbeat';

describe('HeartbeatHelper — memory-pressure capability gating (Bug G1)', () => {
  let helper: HeartbeatHelper;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;

  const HEALTHY = TRAINING_MEM_FLOOR_MB + 500;
  const PRESSURE = 80;

  beforeEach(() => {
    __resetCapabilitySnapshotForTests();
    helper = new HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    __resetCapabilitySnapshotForTests();
  });

  it('strips training-class capabilities when free RAM is below the floor', () => {
    // Cycle 1 — primer with healthy memory so the snapshot is populated.
    helper.applyMemoryPressureFilter(['cpu_inference', 'inference', 'cpu_training', 'gpu_training'], HEALTHY);

    // Cycle 2 — drop below floor.
    const out = helper.applyMemoryPressureFilter(['cpu_inference', 'inference', 'cpu_training', 'gpu_training'], PRESSURE);

    expect(out).toEqual(['cpu_inference', 'inference']);
    expect(out).not.toContain('cpu_training');
    expect(out).not.toContain('gpu_training');
  });

  it('restores training-class capabilities when memory recovers', () => {
    // Cycle 1 — under pressure.
    helper.applyMemoryPressureFilter(['cpu_inference', 'cpu_training', 'gpu_training'], PRESSURE);

    // Cycle 2 — memory recovers.
    const out = helper.applyMemoryPressureFilter(
      ['cpu_inference', 'cpu_training', 'gpu_training'],
      TRAINING_MEM_FLOOR_MB + 1500,
    );

    expect(out).toEqual(['cpu_inference', 'cpu_training', 'gpu_training']);
  });

  it('logs info only on transition, not on every cycle', () => {
    // Cycle 1 — primer with healthy memory; no log expected (no previous snapshot).
    helper.applyMemoryPressureFilter(['cpu_inference', 'cpu_training'], HEALTHY);
    expect(infoSpy).not.toHaveBeenCalled();

    // Cycle 2 — drop below floor → info fires (transition into pressure).
    helper.applyMemoryPressureFilter(['cpu_inference', 'cpu_training'], PRESSURE);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toMatch(/training capability suppressed/);

    // Cycle 3 — still under pressure, same announced set → no log.
    helper.applyMemoryPressureFilter(['cpu_inference', 'cpu_training'], 70);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    // Cycle 4 — memory recovers → info fires (transition out of pressure).
    helper.applyMemoryPressureFilter(['cpu_inference', 'cpu_training'], TRAINING_MEM_FLOOR_MB + 2000);
    expect(infoSpy).toHaveBeenCalledTimes(2);
    expect(infoSpy.mock.calls[1]?.[0]).toMatch(/training capability restored/);

    // Cycle 5 — still healthy, same announced set → no log.
    helper.applyMemoryPressureFilter(['cpu_inference', 'cpu_training'], TRAINING_MEM_FLOOR_MB + 2000);
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  it('does not strip when there are no training-class capabilities to begin with', () => {
    const out = helper.applyMemoryPressureFilter(['cpu_inference', 'inference', 'embedding'], 50);
    expect(out).toEqual(['cpu_inference', 'inference', 'embedding']);
  });
});
