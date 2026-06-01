/**
 * CPU-vs-GPU training capability split, discriminated by CUDA availability.
 *
 * Background: CPU_TRAINING and GPU_TRAINING are SEPARATE coordinator rounds.
 * Nodes are routed work by their advertised capabilities. Previously EVERY
 * GPU node advertised BOTH `cpu_training` AND `gpu_training` (the gate was
 * `hardware.gpuVramGb > 0`), so CUDA pods poached the CPU rounds that should
 * belong to CPU-only / Mac nodes. Worse, a Mac (MPS, no CUDA) advertised
 * `gpu_training` it could not honour, because `train_micro.py` is CUDA-or-CPU
 * only (no MPS branch) — its `gpu_training` cap was meaningless for training.
 *
 * New contract (discriminate by REAL GPU-training capability = CUDA, NOT by
 * `gpuVramGb`):
 *   - `gpu_training`  → advertised ONLY when CUDA is available.
 *   - `cpu_training`  → advertised ONLY when CUDA is NOT available
 *                        ("GPU-only always" — a CUDA node NEVER advertises
 *                        cpu_training, even when gpu_training is later shed
 *                        under memory pressure; the discriminator is the
 *                        stable CUDA-presence signal, not the flapping
 *                        gpu_training cap).
 *   - `gpu_inference` → UNCHANGED. Still gated on `gpuVramGb > 0 && LLM`.
 *                        MPS/Metal accelerates inference (Ollama Metal) so
 *                        Macs legitimately keep `gpu_inference`. Only TRAINING
 *                        is CUDA-gated.
 *
 * Resulting matrix:
 *   - CUDA + vram   → gpu_training YES, cpu_training NO.
 *   - CUDA + vram, gpu_training shed by memory floor → cpu_training STILL NO.
 *   - No CUDA, vram>0 (Mac MPS) → cpu_training YES, gpu_training NO, gpu_inference YES.
 *   - No CUDA, no vram (pure CPU) → cpu_training YES, gpu_training NO, gpu_inference NO.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import logger from '../../../utils/logger';
import {
  HeartbeatHelper,
  __resetCapabilitySnapshotForTests,
  __seedLoraStackProbeForTests,
  __seedCudaCacheForTests,
} from '../heartbeat';
// Namespace import so the fail-closed test can spy on `detectCudaAvailable`
// (the probe heartbeat delegates to) and force it to REJECT — the only way to
// drive the heartbeat-level try/catch, since the real helper is contractually
// "never throws → resolves false".
import * as gpuDetect from '../../../utils/gpu-detect';
import type { Hardware } from '../../hardware/hardware';

// Vina probe must not spawn brew/which during these specs.
jest.mock('../../docking', () => ({
  isVinaAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
  __resetVinaCacheForTests: jest.fn(),
  runDocking: jest.fn(),
  assertBinariesAvailable: jest.fn(),
  parseVinaPdbqt: jest.fn(),
  DockingError: class DockingError extends Error {},
}));

// PyTorch present so cpu_training survives its own probe — the CUDA split is
// what we are isolating, not the torch gate.
jest.mock('../../model/trainer', () => {
  const actual = jest.requireActual<typeof import('../../model/trainer')>(
    '../../model/trainer',
  );
  return {
    ...actual,
    isPyTorchAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
});

// A training LLM resolves so cpu_training is not stripped by the LLM gate.
jest.mock('../../llm/training-llm', () => ({
  resolveTrainingLlmModel: jest
    .fn<() => Promise<string | null>>()
    .mockResolvedValue('llama3.2:1b'),
}));

// CUDA-class GPU node (A5000, 24 GB VRAM, 25 GB RAM) — Ollama up.
const CUDA_GPU_HARDWARE: Hardware = {
  arch: 'x64' as any,
  cpuCores: 16,
  ramGb: 25,
  gpuVramGb: 24,
  hasOllama: true,
  hasCloudLlm: false,
  hardwareClass: 4,
} as Hardware;

// Mac (Apple Silicon, MPS, no CUDA). VRAM is reported (unified memory) but
// torch.cuda.is_available() is false. Ollama Metal is up.
const MAC_MPS_HARDWARE: Hardware = {
  arch: 'arm64' as any,
  cpuCores: 10,
  ramGb: 16,
  gpuVramGb: 18,
  gpuModel: 'Apple M1 Pro',
  hasOllama: true,
  hasCloudLlm: false,
  hardwareClass: 3,
} as Hardware;

// Pure CPU node — no GPU at all, no CUDA.
const PURE_CPU_HARDWARE: Hardware = {
  arch: 'x64' as any,
  cpuCores: 4,
  ramGb: 8,
  gpuVramGb: 0,
  hasOllama: false,
  hasCloudLlm: false,
  hardwareClass: 0,
} as Hardware;

describe('HeartbeatHelper.determineCapabilitiesAsync — CPU/GPU training split by CUDA', () => {
  let helper: HeartbeatHelper;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  // determineCapabilitiesAsync can spawn a non-unref'd 30s kill-timer inside
  // the CUDA / LoRA probes. We seed both caches per test so no real spawn
  // happens, but wrap setTimeout defensively so a stray timer never pins the
  // jest worker (same pattern as heartbeat-lora-capability.spec.ts).
  const realSetTimeout = global.setTimeout;

  beforeEach(() => {
    __resetCapabilitySnapshotForTests();
    // LoRA stack false → lora_training / lora_generation / diloco never push,
    // isolating the cpu/gpu_training decision.
    __seedLoraStackProbeForTests(false, 'test seed — no spawn');
    const unrefing = ((handler: any, timeout?: number, ...args: any[]) => {
      const t = realSetTimeout(handler, timeout, ...args);
      if (typeof (t as any).unref === 'function') (t as any).unref();
      return t;
    }) as any;
    unrefing.__promisify__ = (realSetTimeout as any).__promisify__;
    global.setTimeout = unrefing;
    helper = new HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.setTimeout = realSetTimeout;
    __resetCapabilitySnapshotForTests();
    __seedCudaCacheForTests(null);
    warnSpy.mockRestore();
  });

  it('CUDA available (vram>0) → includes gpu_training, EXCLUDES cpu_training', async () => {
    __seedCudaCacheForTests(true);

    const caps = await helper.determineCapabilitiesAsync(CUDA_GPU_HARDWARE);

    expect(caps).toContain('gpu_training');
    expect(caps).not.toContain('cpu_training');
    // gpu_inference unchanged (vram>0 && Ollama).
    expect(caps).toContain('gpu_inference');
  });

  it('CUDA available but gpu_training shed by memory floor → STILL excludes cpu_training (GPU-only-always)', async () => {
    __seedCudaCacheForTests(true);

    // Force the memory-pressure filter below gpu_training's floor (GPU_TRAINING
    // floor is 4 GB → 100 MB free strips it) but above cpu_training's 900 MB?
    // No — we want to prove cpu_training NEVER reappears. The decision is made
    // in determineCapabilitiesAsync (no cpu_training emitted on a CUDA node) so
    // the downstream memory filter has nothing to fall back to. We assert the
    // RAW async caps already exclude cpu_training, then confirm the pressure
    // filter cannot resurrect it.
    const raw = await helper.determineCapabilitiesAsync(CUDA_GPU_HARDWARE);
    expect(raw).not.toContain('cpu_training');

    // Simulate severe pressure that sheds gpu_training (below its 4 GB floor).
    const filtered = helper.applyMemoryPressureFilter([...raw], 100);
    expect(filtered).not.toContain('gpu_training'); // shed by floor
    expect(filtered).not.toContain('cpu_training'); // never falls back
  });

  it('No CUDA, vram>0 (Mac MPS) → includes cpu_training + gpu_inference, EXCLUDES gpu_training', async () => {
    __seedCudaCacheForTests(false);

    const caps = await helper.determineCapabilitiesAsync(MAC_MPS_HARDWARE);

    expect(caps).toContain('cpu_training');
    expect(caps).toContain('gpu_inference'); // MPS/Metal accelerates inference
    expect(caps).not.toContain('gpu_training');
  });

  it('No CUDA, no GPU (pure CPU) → includes cpu_training, excludes gpu_training/gpu_inference', async () => {
    __seedCudaCacheForTests(false);

    const caps = await helper.determineCapabilitiesAsync(PURE_CPU_HARDWARE);

    expect(caps).toContain('cpu_training');
    expect(caps).not.toContain('gpu_training');
    expect(caps).not.toContain('gpu_inference');
  });

  it('gpu_inference gating is unchanged: CUDA node WITHOUT an LLM endpoint gets neither inference cap but keeps gpu_training', async () => {
    __seedCudaCacheForTests(true);

    const noLlm: Hardware = {
      ...CUDA_GPU_HARDWARE,
      hasOllama: false,
      hasCloudLlm: false,
    } as Hardware;

    const caps = await helper.determineCapabilitiesAsync(noLlm);

    expect(caps).toContain('gpu_training');
    expect(caps).not.toContain('cpu_training');
    expect(caps).not.toContain('gpu_inference'); // no LLM endpoint to serve from
  });
});

describe('HeartbeatHelper.determineCapabilitiesAsync — CUDA probe FAIL-CLOSED (probe throws)', () => {
  let helper: HeartbeatHelper;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let cudaSpy: jest.SpiedFunction<typeof gpuDetect.detectCudaAvailable>;
  const realSetTimeout = global.setTimeout;

  beforeEach(() => {
    __resetCapabilitySnapshotForTests();
    // LoRA stack false → isolate the cpu/gpu_training decision from lora caps.
    __seedLoraStackProbeForTests(false, 'test seed — no spawn');
    // Do NOT seed the CUDA cache: we want the heartbeat to call the probe so
    // the spy below can make it REJECT, exercising the fail-closed try/catch.
    __resetCapabilitySnapshotForTests();
    __seedCudaCacheForTests(null);
    // Force the shared CUDA probe to reject. The real helper never throws
    // (it swallows spawn/timeout errors → false), so the only way to reach the
    // heartbeat-level `catch` is to override the boundary itself.
    cudaSpy = jest
      .spyOn(gpuDetect, 'detectCudaAvailable')
      .mockRejectedValue(new Error('simulated CUDA probe failure (nvidia-smi unavailable)'));
    const unrefing = ((handler: any, timeout?: number, ...args: any[]) => {
      const t = realSetTimeout(handler, timeout, ...args);
      if (typeof (t as any).unref === 'function') (t as any).unref();
      return t;
    }) as any;
    unrefing.__promisify__ = (realSetTimeout as any).__promisify__;
    global.setTimeout = unrefing;
    helper = new HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.setTimeout = realSetTimeout;
    cudaSpy.mockRestore();
    __resetCapabilitySnapshotForTests();
    __seedCudaCacheForTests(null);
    warnSpy.mockRestore();
  });

  it('CUDA probe THROWS on a GPU node (vram>0) → fail-closed to CPU: KEEPS cpu_training, DROPS gpu_training', async () => {
    const caps = await helper.determineCapabilitiesAsync(CUDA_GPU_HARDWARE);

    // The probe rejected → treated as "no CUDA" → node falls back to the CPU
    // path it can always honour, and never advertises an unhonourable
    // gpu_training cap.
    expect(caps).toContain('cpu_training');
    expect(caps).not.toContain('gpu_training');
    // Confirm the fail-closed branch actually ran (the probe was reached and
    // its rejection was caught + logged), not that we silently took the
    // cudaAvailable=false default without ever probing.
    expect(cudaSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CUDA probe failed in training split'),
    );
  });
});
