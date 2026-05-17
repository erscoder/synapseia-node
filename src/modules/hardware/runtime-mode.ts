/**
 * Training runtime mode derivation.
 *
 * Slice 18 (2026-05-17 root cause): the DiLoCo dispatcher used to derive
 * the Python script's hardware mode as:
 *
 *   const hardware = capabilities.includes('cuda') ? 'cuda'
 *                  : capabilities.includes('mps')  ? 'mps'
 *                  : 'cpu';
 *
 * This is wrong. The cap list emitted by `buildCapabilities()` in
 * `modules/hardware/hardware.ts` NEVER contains the literal strings
 * `'cuda'` or `'mps'`. It contains `'gpu'`, `'gpu_training'`,
 * `'gpu_inference'`, `'cpu_training'`, etc. As a result, on an NVIDIA
 * Linux pod with `gpu_training`/`gpu_inference`, the ternary fell through
 * to `'cpu'` and Python's `diloco_train.py` skipped the `bitsandbytes`
 * 4-bit branch — loading the model in fp32. Llama 3.1 8B fp32 weights
 * (~28 GB) + activations OOM'd the pod at ~44 GB RSS and SIGKILL'd it,
 * even though slices 16/17 had correctly installed the CUDA wheel and
 * detected NVIDIA.
 *
 * Correct source-of-truth is the hardware probe (`detectHardware()`):
 *
 *   - `gpuVramGb > 0` on Linux  → NVIDIA (or AMD) GPU present → `'cuda'`
 *   - `gpuVramGb > 0` on Darwin → Apple Silicon Metal → `'mps'`
 *   - otherwise                  → `'cpu'`
 *
 * Windows + NVIDIA is deferred (CUDA on Windows requires a separate
 * wheel install path that isn't wired yet in `install-deps.ts`).
 *
 * The Python script (`scripts/diloco_train.py`) cross-validates the
 * mode against `torch.cuda.is_available()` / `torch.backends.mps.is_available()`
 * and falls back to CPU silently if the runtime doesn't support what
 * Node requested, so a stale advertisement here is recoverable — but
 * advertising `'cpu'` when CUDA IS available is the failure mode that
 * costs us the OOM.
 */

export type TrainingRuntimeMode = 'cuda' | 'mps' | 'cpu';

/**
 * Derive the training runtime mode from a hardware probe result.
 *
 * Pure function — no I/O, no env reads other than the optional
 * `platform` override. Safe to unit-test with synthetic probe values.
 *
 * @param opts.gpuVramGb GPU VRAM in gigabytes from `detectHardware()`.
 *                       `0` means CPU-only (no GPU detected or
 *                       `SYNAPSEIA_CPU_ONLY=true` set).
 * @param opts.platform  Node `process.platform` value. Defaults to the
 *                       current process. Override for tests.
 */
export function deriveTrainingRuntimeMode(opts: {
  gpuVramGb: number;
  platform?: NodeJS.Platform;
}): TrainingRuntimeMode {
  const platform = opts.platform ?? process.platform;
  if (opts.gpuVramGb > 0 && platform === 'linux') return 'cuda';
  if (opts.gpuVramGb > 0 && platform === 'darwin') return 'mps';
  return 'cpu';
}
