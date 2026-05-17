/**
 * Tests for `deriveTrainingRuntimeMode`. Slice 18 — regression guard
 * for the OOM at pod 0.8.82 where the DiLoCo dispatcher fell through
 * to `'cpu'` on an NVIDIA Linux pod and bypassed the bnb 4-bit branch.
 *
 * Each platform x gpuVramGb combination is exercised with a synthetic
 * probe so the helper stays deterministic regardless of the host
 * running the test suite.
 */

import { deriveTrainingRuntimeMode } from '../runtime-mode';

describe('deriveTrainingRuntimeMode', () => {
  it('returns "cuda" for Linux + GPU (NVIDIA pod, slice 18 root case)', () => {
    expect(deriveTrainingRuntimeMode({ gpuVramGb: 24, platform: 'linux' })).toBe('cuda');
  });

  it('returns "cuda" for Linux + small GPU VRAM (>0)', () => {
    expect(deriveTrainingRuntimeMode({ gpuVramGb: 8, platform: 'linux' })).toBe('cuda');
  });

  it('returns "cpu" for Linux + no GPU (CPU-only worker)', () => {
    expect(deriveTrainingRuntimeMode({ gpuVramGb: 0, platform: 'linux' })).toBe('cpu');
  });

  it('returns "mps" for Darwin + GPU VRAM (Apple Silicon)', () => {
    expect(deriveTrainingRuntimeMode({ gpuVramGb: 24, platform: 'darwin' })).toBe('mps');
  });

  it('returns "cpu" for Darwin + no GPU (forced CPU-only Mac)', () => {
    expect(deriveTrainingRuntimeMode({ gpuVramGb: 0, platform: 'darwin' })).toBe('cpu');
  });

  it('returns "cpu" for Windows + GPU (CUDA-on-Windows deferred — slice 18 scope)', () => {
    expect(deriveTrainingRuntimeMode({ gpuVramGb: 24, platform: 'win32' })).toBe('cpu');
  });

  it('returns "cpu" for Windows + no GPU', () => {
    expect(deriveTrainingRuntimeMode({ gpuVramGb: 0, platform: 'win32' })).toBe('cpu');
  });

  it('falls back to process.platform when platform option is omitted', () => {
    // Sanity: helper still returns a valid TrainingRuntimeMode without
    // throwing. We don't assert the value because it varies by host.
    const result = deriveTrainingRuntimeMode({ gpuVramGb: 0 });
    expect(['cuda', 'mps', 'cpu']).toContain(result);
  });
});
