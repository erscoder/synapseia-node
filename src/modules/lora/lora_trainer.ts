/**
 * Node-side LoRA fine-tuning runner.
 *
 * Pipeline (per WO):
 *   1. Detect GPU (bail loud on LORA_GENERATION without GPU).
 *   2. Spawn `python3 scripts/train_lora.py` with the WO payload as
 *      a JSON arg. The Python script downloads the base model, fits
 *      the LoRA adapter on the training set, evaluates on the
 *      validation set, and writes
 *        <out>/adapter_model.safetensors
 *        <out>/adapter_config.json
 *        <out>/metrics.json
 *   3. Read metrics.json + sha256 the adapter file.
 *   4. PUT adapter_model.safetensors to the pre-signed S3 upload URL.
 *   5. Return a LoraSubmissionPayload to the dispatcher.
 *
 * Same trust model as `trainer.ts`: subprocess inherits parent env,
 * no cgroups. We run our own binaries against payloads we issued.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from '../../utils/logger';
import { detectCudaAvailable } from '../../utils/gpu-detect';
import { resolvePython } from '../../utils/python-venv';
import { sanitizedEnvForSubprocess } from '../../utils/subprocess-env';
import {
  maybePauseOllamaForHeavyTraining,
  maybeRestartOllamaAfterHeavyTraining,
} from '../llm/ollama-pause';
import {
  ensureMemForHeavyTraining,
  requiredMemForHeavyTraining,
} from '../model/heavy-training-preflight';
import { startMemorySampler } from '../model/memory-sampler';
import type {
  LoraSubmissionPayload,
  LoraValMetrics,
  LoraWorkOrderPayload,
} from './types';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.LORA_TIMEOUT_MS || '14400000', 10); // 4h
// PYTHON_BIN env wins; otherwise resolve lazily (venv if present, else system).
// Lazy because the venv may be created during boot after this module loads.
function defaultPythonBin(): string {
  return process.env.PYTHON_BIN || resolvePython();
}

export interface RunLoraOptions {
  pythonBin?: string;
  timeoutMs?: number;
  workDir?: string;
  scriptPath?: string;
  /** Override GPU detection (mostly for tests). */
  forceGpu?: boolean;
  /** Override the upload step (mostly for tests). */
  uploader?: (signedUrl: string, filePath: string) => Promise<void>;
}

export interface RunLoraInput {
  workOrderId: string;
  peerId: string;
  payload: LoraWorkOrderPayload;
}

export class LoraError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'LoraError';
  }
}

/**
 * Build a bounded excerpt of the trainer's stderr for an error message.
 *
 * The Python trainer prints its real exception (e.g.
 * `error: Trainer.__init__() got an unexpected keyword argument 'tokenizer'`)
 * at the END of stderr, after pages of torch/transformers import noise. A
 * head-only slice cut that off. We keep a small head (dep-load context, where
 * `No module named 'X'` lives) plus a larger tail (the actual exception).
 */
export function tailStderr(stderr: string, headChars = 400, tailChars = 1200): string {
  const s = stderr.trimEnd();
  if (s.length <= headChars + tailChars) return s;
  return `${s.slice(0, headChars)}\n…[truncated]…\n${s.slice(-tailChars)}`;
}

// ── Top-level entry ─────────────────────────────────────────────────────────

export async function runLora(input: RunLoraInput, options: RunLoraOptions = {}): Promise<LoraSubmissionPayload> {
  const { workOrderId, peerId, payload } = input;
  if (payload.subtype === 'LORA_GENERATION' && !(options.forceGpu ?? await hasGpu(payload.subtype))) {
    throw new LoraError(
      `LORA_GENERATION (BioGPT-Large) requires a GPU; this node has none. Refusing to run on CPU.`,
      'precheck',
    );
  }

  const workDir = options.workDir ?? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-lora-'));
  try {
    const scriptPath = options.scriptPath ?? resolveTrainScript();
    await assertFileExists(scriptPath, `Python LoRA trainer script not found at ${scriptPath}`);

    // Slice 8 (2026-05-17): wrap the python spawn in the same Ollama
    // pause + preflight memory gate envelope DiLoCo uses. `train_lora.py`
    // loads a 7B-class fp16 base via `AutoModelForCausalLM.from_pretrained`
    // without quantization (~14 GB load peak), so the OOM-kill window
    // observed live on pod A40 for DiLoCo applies identically here. The
    // pause MUST happen before the preflight gate so the kernel has a
    // chance to reclaim Ollama's resident weights before we re-probe;
    // the restart MUST happen in `finally` so an `InsufficientMemoryError`
    // (controlled skip) does not leak the daemon in paused state.
    //
    // `InsufficientMemoryError` bubbles up through `runLora` into
    // `executeLoraWorkOrder`, which converts it to
    // `{ success: false, result: 'LoRA skipped: ...' }`. Per
    // reviewer-lesson P21 we do NOT client-side re-queue — the
    // coordinator's ACCEPTED-TTL expiry handles re-routing.
    const ollamaHandle = await maybePauseOllamaForHeavyTraining();
    try {
      await ensureMemForHeavyTraining(requiredMemForHeavyTraining('LoRA'), { label: 'LoRA' });
      await runPython(
        options.pythonBin ?? defaultPythonBin(),
        scriptPath,
        { ...payload, peerId, workOrderId, outDir: workDir },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    } finally {
      await maybeRestartOllamaAfterHeavyTraining(ollamaHandle);
    }

    const adapterPath = path.join(workDir, 'adapter_model.safetensors');
    const metricsPath = path.join(workDir, 'metrics.json');
    await assertFileExists(adapterPath, 'Trainer did not emit adapter_model.safetensors');
    await assertFileExists(metricsPath, 'Trainer did not emit metrics.json');

    const adapterBytes = await fs.promises.readFile(adapterPath);
    const sha256 = 'sha256:' + createHash('sha256').update(adapterBytes).digest('hex');
    const metrics: LoraValMetrics = JSON.parse(await fs.promises.readFile(metricsPath, 'utf8'));

    const upload = options.uploader ?? defaultUploader;
    await upload(payload.uploadUrl, adapterPath);

    return {
      adapterId: payload.adapterId,
      artifactUri: payload.uploadUrl.split('?')[0], // strip the query string for storage
      artifactSha256: sha256,
      reportedValMetrics: metrics,
      trainerPeerId: peerId,
    };
  } finally {
    if (!options.workDir) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * GPU capability check — true means "this node MAY be able to run a
 * LoRA training subprocess on a GPU/MPS backend". CUDA is auto-detected
 * via the shared `detectCudaAvailable()` probe (utils/gpu-detect.ts), the
 * SAME `torch.cuda.is_available()` probe the heartbeat uses to advertise
 * `gpu_training` — a single source of truth so the two paths can never
 * diverge again. The Python script runs the authoritative check inside the
 * subprocess; we mirror it here so the precheck refuses BEFORE we waste a
 * model download.
 *
 * NOTE: Apple Silicon MPS is allowed for CLASSIFICATION only — `torch.cuda`
 * is always false on macOS, so we special-case darwin/arm64 to permit the
 * MPS encoder path for non-GENERATION subtypes (defence-in-depth mirroring
 * `train_lora.py`, which rejects GENERATION on MPS).
 *
 * @param subtype optional — when provided, the check refuses MPS for
 *                `LORA_GENERATION` (Apple Silicon BioGPT-Large doesn't fit /
 *                is unsupported by torch's MPS backend at our model sizes).
 */
async function hasGpu(subtype?: 'LORA_CLASSIFICATION' | 'LORA_GENERATION'): Promise<boolean> {
  if (os.platform() === 'darwin' && os.arch() === 'arm64') {
    // MPS-capable but only useful for CLASSIFICATION (encoder). torch.cuda is
    // false on Mac, so do NOT consult the CUDA probe here.
    return subtype !== 'LORA_GENERATION';
  }
  // Linux / Windows: detect CUDA via the real torch.cuda probe.
  return detectCudaAvailable();
}

function resolveTrainScript(): string {
  // Mirrors `trainer.ts` resolution. The script lives at
  // `packages/node/scripts/train_lora.py`. The tsup banner injects
  // `__filename` per chunk so we use it directly; falls back to cwd.
  const moduleDir = (() => {
    try {
      // @ts-ignore — tsup banner injects __filename in CJS chunks.
      if (typeof __filename !== 'undefined') return path.dirname(__filename);
    } catch { /* fall through */ }
    return process.cwd();
  })();
  const candidates = [
    path.resolve(moduleDir, '..', 'scripts', 'train_lora.py'),
    path.resolve(moduleDir, '..', '..', 'scripts', 'train_lora.py'),
    path.resolve(moduleDir, '..', '..', '..', 'scripts', 'train_lora.py'),
    path.resolve(process.cwd(), 'scripts', 'train_lora.py'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]; // surfaces the first path in the assert error
}

async function assertFileExists(p: string, msg: string): Promise<void> {
  try { await fs.promises.access(p); } catch { throw new LoraError(msg, 'fs'); }
}

function runPython(bin: string, script: string, payload: object, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // SECURITY (F-node-008 / P9): strip wallet / keystore secrets
      // from the env passed to the python child. A poisoned wheel in
      // transformers/peft/accelerate would otherwise be able to read
      // SYNAPSEIA_WALLET_PASSWORD via `os.environ` and exfiltrate the
      // operator's passphrase. See utils/subprocess-env.ts.
      env: sanitizedEnvForSubprocess({
        // Conservative thread caps so a busy CPU node doesn't OOM.
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '4',
      }),
    });

    // Slice 10b (Plan B, 2026-05-17): continuous memory sampler
    // alongside the python proc. Emits a single summary line on stop
    // (freeMB peak/min + rssMB peak + sample count) so LORA_REQUIRED_FREE_MB
    // can be tuned from observed peak distributions. Sampler is started
    // only when the spawn produced a pid; stop is idempotent and runs in
    // BOTH the close and error listeners below plus the timeout path.
    const sampler = proc.pid !== undefined
      ? startMemorySampler('LoRA', proc.pid)
      : { stop: () => { /* no pid — sampler not started */ } };

    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      // Forward python progress lines to the node logger. The script is
      // expected to emit `progress {json}` lines.
      const txt = d.toString().trim();
      if (txt) logger.log(`[lora] ${txt}`);
    });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.stdin?.write(JSON.stringify(payload) + '\n');
    proc.stdin?.end();

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      sampler.stop();
      reject(new LoraError(`LoRA trainer timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);

    proc.on('error', err => { clearTimeout(timer); sampler.stop(); reject(new LoraError(err.message, 'spawn')); });
    proc.on('close', code => {
      clearTimeout(timer);
      sampler.stop();
      if (code === 0) {
        resolve();
        return;
      }
      // Surface a friendly hint when the failure is a missing Python dep
      // (transformers/peft/datasets/safetensors/accelerate). Keeps the raw
      // exit code + stderr so reviewers can still see the original error.
      const missingDep = stderr.match(/No module named '(transformers|peft|datasets|safetensors|accelerate)'/);
      const hint = missingDep
        ? `[LoRA] Python deps missing. Install: pip3 install transformers peft datasets safetensors accelerate\n`
        : '';
      // The real Python exception (e.g. `TypeError: ... unexpected keyword
      // argument 'tokenizer'`) is printed at the END of stderr by the
      // script's top-level handler. A HEAD-only slice (slice(0, 800)) buried
      // it under torch/transformers import chatter. Capture head + tail so
      // both the dep-load context and the actual error survive.
      const errTail = tailStderr(stderr);
      reject(new LoraError(`${hint}python3 train_lora.py exited with code ${code}: ${errTail}`, 'python'));
    });
  });
}

async function defaultUploader(signedUrl: string, filePath: string): Promise<void> {
  // Plain HTTPS PUT. The signed URL includes auth + content type
  // expectations (set by AdapterStorageService.getUploadUrl).
  const buf = await fs.promises.readFile(filePath);
  const res = await fetch(signedUrl, {
    method: 'PUT',
    body: buf,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) {
    throw new LoraError(`S3 upload failed: HTTP ${res.status} ${res.statusText}`, 'upload');
  }
}
