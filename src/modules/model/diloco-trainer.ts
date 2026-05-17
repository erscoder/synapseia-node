/**
 * DiLoCo TypeScript wrapper
 * Spawns diloco_train.py and captures results from stdout JSON lines.
 */

import { Injectable } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { resolvePython } from '../../utils/python-venv';
import {
  maybePauseOllamaForHeavyTraining,
  maybeRestartOllamaAfterHeavyTraining,
} from '../llm/ollama-pause';
import {
  ensureMemForHeavyTraining,
  requiredMemForHeavyTraining,
} from './heavy-training-preflight';
import { startMemorySampler } from './memory-sampler';

/**
 * Directory of THIS bundled module. `__dirname` is provided in all three
 * runtimes: CJS jest global, tsup `shims: true` ESM injection in the
 * production bundle, and the install-location bundle path under Tauri.
 * See trainer.ts for the full rationale.
 */
function moduleDir(): string {
  return __dirname;
}

function resolveDilocoScript(): string {
  const here = moduleDir();
  const candidates = [
    resolve(here, 'scripts/diloco_train.py'),
    resolve(here, '../scripts/diloco_train.py'),
    resolve(here, '../../scripts/diloco_train.py'),
    resolve(here, '../../../scripts/diloco_train.py'),
    resolve(process.cwd(), 'scripts/diloco_train.py'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export type SpawnFn = (cmd: string, args: string[], options: Record<string, unknown>) => ChildProcess;
export type StatFn = (path: string) => { size: number };

export interface DiLoCoHyperparams {
  learningRate?: number;
  batchSize?: number;
  hiddenDim?: number;
  numLayers?: number;
  numHeads?: number;
  activation?: 'gelu' | 'silu' | 'relu';
  normalization?: 'layernorm' | 'rmsnorm';
  initScheme?: 'xavier' | 'kaiming' | 'normal';
  warmupSteps?: number;
  weightDecay?: number;
  maxTrainSeconds?: number;
}

export interface DiLoCoConfig {
  modelId: string;
  adapterPath?: string;
  datasetPath: string;
  innerSteps: number;
  hyperparams: DiLoCoHyperparams;
  hardware: 'cpu' | 'mps' | 'cuda';
  testMode?: boolean;
  pythonScriptPath?: string;
}

export interface DiLoCoProgressUpdate {
  step: number;
  loss: number;
  lr: number;
}

export interface DiLoCoResult {
  finalLoss: number;
  valLoss: number;
  innerSteps: number;
  durationMs: number;
  gradientPath: string;
  gradientSizeBytes: number;
}

@Injectable()
export class DiLoCoTrainerHelper {
  /**
   * Public entry point. Wraps the actual python spawn in a Bug 27
   * pause/restart envelope: on memory-constrained containers (<80 GB by
   * default) Ollama is SIGTERM'd before the spawn and restarted in a
   * `finally` block regardless of success/failure. See
   * `modules/llm/ollama-pause.ts` for the full invariant and tradeoffs.
   *
   * Bug 28 (2026-05-17): AFTER Ollama is paused and BEFORE the python
   * spawn, run `ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB)` —
   * a controlled gate that drops FS page-cache + forces V8 GC and
   * re-probes cgroup free memory.
   * If still insufficient, an `InsufficientMemoryError` is thrown and
   * propagates to `executeDiLoCoWorkOrder` which converts it into
   * `{ success: false }`. This prevents the SIGKILL loop observed
   * live on pod A40 (cgroup 46.6 GB). The `finally` block still
   * restarts Ollama so a preflight failure does not leak the daemon
   * in the paused state.
   */
  async runDiLoCoInnerLoop(
    config: DiLoCoConfig,
    onProgress?: (update: DiLoCoProgressUpdate) => void,
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    statFn: StatFn = (p) => statSync(p) as { size: number },
  ): Promise<DiLoCoResult> {
    const ollamaHandle = await maybePauseOllamaForHeavyTraining();
    try {
      await ensureMemForHeavyTraining(requiredMemForHeavyTraining('DiLoCo'), { label: 'DiLoCo' });
      return await this._spawnDiLoCoTrain(config, onProgress, spawnFn, statFn);
    } finally {
      await maybeRestartOllamaAfterHeavyTraining(ollamaHandle);
    }
  }

  /**
   * Internal: spawn `diloco_train.py` and resolve with the parsed
   * result. Extracted from `runDiLoCoInnerLoop` so the pause/restart
   * envelope wraps a single async call. No behavioral changes from
   * the pre-Bug-27 implementation.
   */
  private async _spawnDiLoCoTrain(
    config: DiLoCoConfig,
    onProgress: ((update: DiLoCoProgressUpdate) => void) | undefined,
    spawnFn: SpawnFn,
    statFn: StatFn,
  ): Promise<DiLoCoResult> {
    const scriptPath = config.pythonScriptPath ?? resolveDilocoScript();
    const startTime = Date.now();
    const DILOCO_TIMEOUT_MS = parseInt(process.env.DILOCO_TIMEOUT_MS || '900000', 10);

    const payload = {
      modelId: config.modelId, adapterPath: config.adapterPath ?? null,
      datasetPath: config.datasetPath, innerSteps: config.innerSteps,
      hyperparams: config.hyperparams, hardware: config.hardware,
      testMode: config.testMode ?? false,
    };

    // Bug 18 v3: DiLoCo runtime is LOCAL-ONLY — the foundation model is
    // pre-downloaded by `syn install-deps` and `diloco_train.py` loads
    // with `local_files_only=True`. No HF Hub round-trip happens at
    // runtime, so HF_TOKEN is no longer needed (or passed). We also
    // strip HF_TOKEN from the child env defensively: even if some
    // operator sets it for unrelated tooling, the Python script will
    // never look at it for the model load path.
    //
    // Forwarded env vars left alone:
    //   - HF_HUB_ENABLE_HF_TRANSFER: stays opt-in. With local_files_only
    //     it shouldn't matter, but a future code path that re-enables
    //     a network call would still want the same opt-in posture.
    //   - HF_HUB_DISABLE_TELEMETRY / TRANSFORMERS_OFFLINE: harmless.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.HF_TOKEN;

    return new Promise((res, reject) => {
      const proc = spawnFn(resolvePython(), [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
      let stderr = '';
      let finalResult: DiLoCoResult | null = null;
      let timedOut = false;

      // Slice 10b (Plan B, 2026-05-17): continuous memory sampler
      // running alongside the python proc. Emits a single summary line
      // on stop (freeMB peak/min + rssMB peak + sample count) so we
      // can tune DILOCO_REQUIRED_FREE_MB from observed peak
      // distributions instead of back-of-napkin estimates.
      // Started only when the spawn produced a pid (test mocks may
      // not). Stop is idempotent and runs in BOTH the close and
      // error listeners below.
      const sampler = (proc as { pid?: number }).pid
        ? startMemorySampler('DiLoCo', (proc as { pid: number }).pid)
        : { stop: () => { /* no pid — sampler not started */ } };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill?.('SIGTERM');
        sampler.stop();
        reject(new Error(`DiLoCo training timed out after ${DILOCO_TIMEOUT_MS / 1000}s`));
      }, DILOCO_TIMEOUT_MS);

      proc.stdin!.write(JSON.stringify(payload));
      proc.stdin!.end();

      proc.stdout!.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n').filter(l => l.trim())) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed['error']) { clearTimeout(timeoutHandle); reject(new Error(String(parsed['error']))); return; }
            if (parsed['step'] !== undefined && parsed['loss'] !== undefined && onProgress) {
              onProgress({ step: parsed['step'] as number, loss: parsed['loss'] as number, lr: (parsed['lr'] as number) ?? 0 });
            }
            if (parsed['result']) {
              const r = parsed['result'] as Record<string, unknown>;
              const gradientPath = String(r['gradientPath']);
              let gradientSizeBytes = 0;
              try { gradientSizeBytes = statFn(gradientPath).size; } catch { /* */ }
              finalResult = {
                finalLoss: Number(r['finalLoss']) || 0, valLoss: Number(r['valLoss']) || 0,
                innerSteps: Number(r['innerSteps']) || config.innerSteps,
                durationMs: Date.now() - startTime, gradientPath, gradientSizeBytes,
              };
            }
          } catch { /* ignore non-JSON */ }
        }
      });

      // Cap stderr accumulation to last 8KB so a chatty HF tqdm bar can't
      // balloon a node-side string forever, while still preserving the
      // tail (where the actual crash trace lives if Python managed to
      // print one before being signalled).
      const STDERR_CAP_BYTES = 8 * 1024;
      proc.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > STDERR_CAP_BYTES) {
          stderr = stderr.slice(-STDERR_CAP_BYTES);
        }
      });

      // Bug 18 v3: `close` callback receives `(code: number | null, signal:
      // NodeJS.Signals | null)`. `code === null` means the process was
      // killed by a signal — surface the signal name + stderr tail.
      // Since the runtime is now local-only (no HF Hub I/O), SIGPIPE
      // is unexpected; the hint mentions disk/IPC rather than network.
      proc.on('close', (code, signal) => {
        clearTimeout(timeoutHandle);
        sampler.stop();
        if (timedOut) return;
        if (code === null && signal) {
          const hint = signal === 'SIGKILL' ? 'likely OOM-killer or container memory limit'
            : signal === 'SIGSEGV' ? 'native crash (safetensors / torch C-ext); check disk integrity of the install-deps snapshot'
            : signal === 'SIGPIPE' ? 'broken pipe (unexpected with local_files_only; check stdout/stderr consumer)'
            : signal === 'SIGTERM' ? 'terminated by external signal'
            : `signal ${signal}`;
          reject(new Error(`diloco_train.py killed by signal ${signal} (${hint}). stderr tail: ${stderr.trim().slice(-512) || '(empty)'}`));
          return;
        }
        if (code !== 0) { reject(new Error(`diloco_train.py exited with code ${code}: ${stderr.trim().slice(-512) || 'unknown error'}`)); return; }
        if (!finalResult) { reject(new Error('DiLoCo training completed but no result received')); return; }
        res(finalResult);
      });

      proc.on('error', (err) => { clearTimeout(timeoutHandle); sampler.stop(); reject(new Error(`Failed to spawn diloco_train.py: ${err.message}`)); });
    });
  }
}

// Backward-compatible standalone export
const _dilocoInstance = new DiLoCoTrainerHelper();
export const runDiLoCoInnerLoop = (
  config: DiLoCoConfig, onProgress?: (update: DiLoCoProgressUpdate) => void,
  spawnFn?: SpawnFn, statFn?: StatFn,
) => _dilocoInstance.runDiLoCoInnerLoop(config, onProgress, spawnFn, statFn);
