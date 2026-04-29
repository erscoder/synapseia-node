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
import type {
  LoraSubmissionPayload,
  LoraValMetrics,
  LoraWorkOrderPayload,
} from './types';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.LORA_TIMEOUT_MS || '14400000', 10); // 4h
const DEFAULT_PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

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

// ── Top-level entry ─────────────────────────────────────────────────────────

export async function runLora(input: RunLoraInput, options: RunLoraOptions = {}): Promise<LoraSubmissionPayload> {
  const { workOrderId, peerId, payload } = input;
  if (payload.subtype === 'LORA_GENERATION' && !(options.forceGpu ?? hasGpu(payload.subtype))) {
    throw new LoraError(
      `LORA_GENERATION (BioGPT-Large) requires a GPU; this node has none. Refusing to run on CPU.`,
      'precheck',
    );
  }

  const workDir = options.workDir ?? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-lora-'));
  try {
    const scriptPath = options.scriptPath ?? resolveTrainScript();
    await assertFileExists(scriptPath, `Python LoRA trainer script not found at ${scriptPath}`);

    await runPython(
      options.pythonBin ?? DEFAULT_PYTHON_BIN,
      scriptPath,
      { ...payload, peerId, workOrderId, outDir: workDir },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

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
 * Cheap GPU heuristic — true means "this node MAY be able to run a
 * LoRA training subprocess on a GPU/MPS backend". The Python script
 * runs the authoritative check via `torch.cuda.is_available()` and
 * (for MPS) `torch.backends.mps.is_available()`. NOTE: Apple Silicon
 * MPS is allowed for CLASSIFICATION only — `train_lora.py` rejects
 * GENERATION on MPS as defence in depth, but we mirror that rule
 * here so the precheck refuses GENERATION on MPS BEFORE we waste a
 * model download.
 *
 * @param subtype optional — when provided, the heuristic refuses MPS
 *                for `LORA_GENERATION` (Apple Silicon BioGPT-Large
 *                doesn't fit / is unsupported by torch's MPS backend
 *                at the model sizes we ship).
 */
function hasGpu(subtype?: 'LORA_CLASSIFICATION' | 'LORA_GENERATION'): boolean {
  if (process.env.SYN_FORCE_GPU === 'true') return true;
  if (process.env.SYN_FORCE_NO_GPU === 'true') return false;
  const platform = os.platform();
  if (platform === 'darwin' && os.arch() === 'arm64') {
    // MPS-capable but only useful for CLASSIFICATION (encoder).
    return subtype !== 'LORA_GENERATION';
  }
  // Linux / Windows: rely on env var set by the launcher (e.g.
  // start-node detects nvidia-smi at startup and exports SYN_FORCE_GPU=true).
  return false;
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
      env: {
        ...process.env,
        // Conservative thread caps so a busy CPU node doesn't OOM.
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '4',
      },
    });
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
      reject(new LoraError(`LoRA trainer timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);

    proc.on('error', err => { clearTimeout(timer); reject(new LoraError(err.message, 'spawn')); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new LoraError(`python3 train_lora.py exited with code ${code}: ${stderr.slice(0, 800)}`, 'python'));
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
