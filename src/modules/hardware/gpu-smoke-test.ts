/**
 * GPU smoke test — runs once at boot to verify the GPU code path is
 * actually functional on this machine before nodes accept GPU work.
 *
 * Why: the Synapseia GPU path (training + inference via Ollama with
 * num_gpu offload, llama.cpp etc.) has never been exercised on real
 * GPU hardware in our dev fleet. Testnet operators will run on
 * unfamiliar configs (NVIDIA RTX, Apple Silicon, AMD ROCm, server
 * Tesla, etc.). A node that detects a GPU but silently falls back to
 * CPU is invisible from the coordinator's view today.
 *
 * Behavior:
 *   1. If hardware reports zero VRAM OR Ollama isn't reachable
 *      → return { status: 'skipped' } and no work is done.
 *   2. Otherwise: POST one short prompt to Ollama with `num_gpu=99`
 *      to force GPU offload, 30 s timeout. Measure latency.
 *   3. On 2xx with non-empty response → 'passed' with latencyMs.
 *      On any other outcome → 'failed' with errorMessage; the node
 *      keeps running on CPU.
 *
 * The result is emitted as a `gpu.smoke.{passed|failed|skipped}`
 * telemetry event by the caller — this module is pure.
 */

import type { Hardware } from './hardware';

const SMOKE_PROMPT = 'hello';
const SMOKE_TIMEOUT_MS = 30_000;
const SMOKE_MODEL_FALLBACK = 'qwen2.5:0.5b';

export type GpuSmokeStatus = 'passed' | 'failed' | 'skipped';

export type GpuProbe =
  | 'ollama-cuda'
  | 'ollama-metal'
  | 'ollama-rocm'
  | 'cpu'
  | 'unknown';

export interface GpuSmokeResult {
  status: GpuSmokeStatus;
  probe: GpuProbe;
  latencyMs?: number;
  vramUsedMB?: number;
  errorMessage?: string;
  fallbackToCpu?: boolean;
  model?: string;
}

export interface GpuSmokeTestOptions {
  hardware: Hardware;
  ollamaUrl: string;
  /** Defaults to qwen2.5:0.5b (smallest model expected to be installed). */
  model?: string;
  /** Defaults to 30 s. */
  timeoutMs?: number;
  /** Test override — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Best-effort guess at which probe applies, from the Hardware data. */
function inferProbe(hw: Hardware): GpuProbe {
  if (!hw.gpuModel || hw.gpuVramGb <= 0) return 'cpu';
  const m = hw.gpuModel.toLowerCase();
  if (/(nvidia|geforce|rtx|gtx|tesla|quadro|cuda)/.test(m)) return 'ollama-cuda';
  if (/(apple|m[1-9]|silicon|metal)/.test(m)) return 'ollama-metal';
  if (/(amd|radeon|rocm)/.test(m)) return 'ollama-rocm';
  return 'unknown';
}

export async function runGpuSmokeTest(
  opts: GpuSmokeTestOptions,
): Promise<GpuSmokeResult> {
  const probe = inferProbe(opts.hardware);

  // No GPU detected → skip.
  if (probe === 'cpu' || opts.hardware.gpuVramGb <= 0) {
    return { status: 'skipped', probe: 'cpu' };
  }
  // Ollama not available → skip (Ollama owns the GPU offload path).
  if (!opts.hardware.hasOllama) {
    return {
      status: 'skipped',
      probe,
      errorMessage: 'Ollama not available on this node',
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? SMOKE_MODEL_FALLBACK;
  const timeoutMs = opts.timeoutMs ?? SMOKE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${opts.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt: SMOKE_PROMPT,
        stream: false,
        options: { num_gpu: 99, num_predict: 8 },
      }),
    });
    if (!res.ok) {
      return {
        status: 'failed',
        probe,
        errorMessage: `ollama ${res.status} ${res.statusText}`,
        fallbackToCpu: true,
        model,
      };
    }
    const json = (await res.json()) as { response?: string };
    const latencyMs = Date.now() - startedAt;
    if (!json?.response || json.response.length === 0) {
      return {
        status: 'failed',
        probe,
        errorMessage: 'empty response from ollama',
        fallbackToCpu: true,
        model,
      };
    }
    return {
      status: 'passed',
      probe,
      latencyMs,
      model,
    };
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      probe,
      errorMessage:
        e.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : `${e.name}: ${e.message}`,
      fallbackToCpu: true,
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}
