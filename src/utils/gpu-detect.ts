/**
 * Shared CUDA detection — SINGLE SOURCE OF TRUTH for "does this node have a
 * usable NVIDIA GPU?".
 *
 * Background (P6): two GPU-detection paths used to diverge. The heartbeat
 * capability advertiser ran a real `torch.cuda.is_available()` probe, while
 * the LoRA trainer/validator `hasGpu()` relied on an `SYN_FORCE_GPU` env var
 * the pod launchers never exported. Result: GPU pods correctly advertised
 * `gpu_training` over the heartbeat yet refused every LORA_GENERATION work
 * order ("requires a GPU; this node has none"). Consolidating both paths onto
 * this one probe is the fix.
 *
 * The probe spawns `python3 -c "import torch; assert torch.cuda.is_available()"`
 * and treats exit code 0 as "CUDA available". CUDA availability is a hardware
 * fact stable for the process lifetime, so we positive-cache it (a `true`
 * result is never re-probed). A `false`/error result is NOT cached so a
 * late-arriving driver/venv can flip the answer on a subsequent call.
 */

import { resolvePython } from './python-venv';

/** Positive-only cache. `true` is sticky; `null`/false re-probes. */
let cudaCache: boolean | null = null;

/**
 * Test-only spawn override. The dynamic `await import('node:child_process')`
 * below bypasses `jest.mock('child_process')`, so module-level injection is
 * the cleanest test surface (it also drove the Bug 23 timer-leak regression
 * tests in the heartbeat). Production code never sets this; `null` means
 * "use the real spawn".
 */
let probeSpawnOverrideForTest:
  | ((cmd: string, args: readonly string[]) => import('node:child_process').ChildProcess)
  | null = null;

export function __setCudaProbeSpawnOverrideForTests(
  fn: ((cmd: string, args: readonly string[]) => import('node:child_process').ChildProcess) | null,
): void {
  probeSpawnOverrideForTest = fn;
}

/** Test-only: reset the cache so a fresh probe runs. */
export function __resetCudaCacheForTests(): void {
  cudaCache = null;
}

/** Test-only: seed the cache directly without spawning python. */
export function __seedCudaCacheForTests(value: boolean | null): void {
  cudaCache = value;
}

/**
 * Returns `true` when `torch.cuda.is_available()` succeeds. Positive-cached.
 * Never throws — any spawn/timeout/error resolves to `false`.
 */
export async function detectCudaAvailable(): Promise<boolean> {
  if (cudaCache === true) return true;
  const spawn = probeSpawnOverrideForTest
    ?? (await import('node:child_process')).spawn;
  const result = await new Promise<boolean>((res) => {
    const proc = spawn(
      resolvePython(),
      ['-c', 'import torch; assert torch.cuda.is_available()'],
      { stdio: ['ignore', 'pipe', 'pipe'] } as any,
    );
    let settled = false;
    const settle = (v: boolean) => { if (!settled) { settled = true; res(v); } };
    // Kill timer must be cleared in success/error paths — otherwise it pins
    // the event loop until firing, delaying graceful shutdown (Bug 23).
    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      settle(false);
    }, 30_000);
    proc.on('close', (code: number | null) => { clearTimeout(killTimer); settle(code === 0); });
    proc.on('error', () => { clearTimeout(killTimer); settle(false); });
  });
  if (result) cudaCache = true;
  return result;
}
