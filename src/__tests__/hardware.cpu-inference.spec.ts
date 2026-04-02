/**
 * Sprint F Tests — hardware.canInference() and buildCapabilities() cpu_inference
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as childProcess from 'child_process';
import { HardwareHelper, canInference, type Hardware } from '../modules/hardware/hardware';

// ---------------------------------------------------------------------------
// Helper to create a HardwareHelper with overridden detectHardware
// ---------------------------------------------------------------------------

function createHelperWithHardware(hw: Partial<Hardware> = {}): HardwareHelper {
  const helper = new HardwareHelper();
  const defaults: Hardware = { cpuCores: 4, ramGb: 8, gpuVramGb: 0, tier: 0, hasOllama: false };
  jest.spyOn(helper, 'detectHardware').mockReturnValue({ ...defaults, ...hw });
  return helper;
}

describe('canInference()', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return true when cpuCores >= 2 and ramGb >= 4', () => {
    const helper = createHelperWithHardware({ cpuCores: 4, ramGb: 8 });
    expect(helper.canInference()).toBe(true);
  });

  it('should return false when cpuCores < 2', () => {
    const helper = createHelperWithHardware({ cpuCores: 1, ramGb: 8 });
    expect(helper.canInference()).toBe(false);
  });

  it('should return false when ramGb < 4', () => {
    const helper = createHelperWithHardware({ cpuCores: 4, ramGb: 2 });
    expect(helper.canInference()).toBe(false);
  });

  it('should return true with exactly 2 cores and exactly 4 GB RAM', () => {
    const helper = createHelperWithHardware({ cpuCores: 2, ramGb: 4 });
    expect(helper.canInference()).toBe(true);
  });

  it('should return false when both cores < 2 and ramGb < 4', () => {
    const helper = createHelperWithHardware({ cpuCores: 1, ramGb: 1 });
    expect(helper.canInference()).toBe(false);
  });

  it('should return false when cores = 0', () => {
    const helper = createHelperWithHardware({ cpuCores: 0, ramGb: 16 });
    expect(helper.canInference()).toBe(false);
  });

  it('should return false when ramGb = 0', () => {
    const helper = createHelperWithHardware({ cpuCores: 8, ramGb: 0 });
    expect(helper.canInference()).toBe(false);
  });

  it('should return true for a high-end machine (16 cores, 64 GB)', () => {
    const helper = createHelperWithHardware({ cpuCores: 16, ramGb: 64 });
    expect(helper.canInference()).toBe(true);
  });

  it('standalone canInference() export should return a boolean', () => {
    // The standalone export runs against real hardware — just check type
    expect(typeof canInference()).toBe('boolean');
  });
});

describe('buildCapabilities() includes cpu_inference', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should include cpu_inference when canInference returns true', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canInference').mockReturnValue(true);
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(false);

    const hw: Hardware = { cpuCores: 4, ramGb: 8, gpuVramGb: 0, tier: 0, hasOllama: false };
    const caps = helper.buildCapabilities(hw);

    expect(caps).toContain('cpu_inference');
  });

  it('should NOT include cpu_inference when canInference returns false', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canInference').mockReturnValue(false);
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(false);

    const hw: Hardware = { cpuCores: 1, ramGb: 2, gpuVramGb: 0, tier: 0, hasOllama: false };
    const caps = helper.buildCapabilities(hw);

    expect(caps).not.toContain('cpu_inference');
  });

  it('should include both training and cpu_inference when both are available', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canInference').mockReturnValue(true);
    jest.spyOn(helper, 'canTrain').mockReturnValue(true);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(false);

    const hw: Hardware = { cpuCores: 8, ramGb: 16, gpuVramGb: 0, tier: 0, hasOllama: false };
    const caps = helper.buildCapabilities(hw);

    expect(caps).toContain('training');
    expect(caps).toContain('cpu_inference');
  });

  it('should include gpu and cpu capabilities along with cpu_inference', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canInference').mockReturnValue(true);
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(false);

    const hw: Hardware = { cpuCores: 4, ramGb: 8, gpuVramGb: 16, tier: 3, hasOllama: false };
    const caps = helper.buildCapabilities(hw);

    expect(caps).toContain('cpu');
    expect(caps).toContain('gpu');
    expect(caps).toContain('cpu_inference');
  });
});
