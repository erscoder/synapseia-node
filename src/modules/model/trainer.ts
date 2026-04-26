/**
 * Micro-trainer — executes Python training script and captures results
 */

import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import logger from '../../utils/logger';
import type { MutationProposal } from './mutation-engine';

/**
 * Directory of THIS bundled module. Works across all three runtimes
 * because `__dirname` is provided in each:
 *   1. Jest (CJS)            → CJS global injected by Node.
 *   2. Production ESM bundle → tsup `shims: true` injects __dirname /
 *                              __filename at the top of the bundle.
 *   3. Tauri spawn (cwd='/') → uses the bundle's __dirname (the install
 *                              location), never falls back to cwd.
 */
function moduleDir(): string {
  return __dirname;
}

export interface TrainingResult {
  runNumber: number;
  finalLoss: number;
  valLoss: number;
  improvementPercent: number;
  durationMs: number;
  config: MutationProposal['hyperparams'];
  lossCurve: number[];
  hardwareUsed: 'cpu' | 'gpu';
}

export interface TrainingOptions {
  proposal: MutationProposal;
  datasetPath: string;
  hardware: 'cpu' | 'gpu';
  pythonScriptPath?: string;
  runNumber?: number;
}

@Injectable()
export class TrainerHelper {
  private static pyTorchCache: boolean | null = null;
  private static trainingInProgress = false;

  async isPyTorchAvailable(): Promise<boolean> {
    // Only cache positive detections. If torch import failed (transient timeout,
    // python warming up, slow CPU under training load), we want to retry on the
    // next heartbeat instead of permanently losing the cpu_training capability
    // until the process restarts. A successful detection is stable — once torch
    // is importable it stays importable for the process lifetime.
    if (TrainerHelper.pyTorchCache === true) return true;

    const result = await new Promise<boolean>((res) => {
      const proc = spawn('python3', ['-c', 'import torch; print(torch.__version__)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      const settle = (v: boolean) => { if (!settled) { settled = true; res(v); } };
      proc.on('close', (code) => settle(code === 0));
      proc.on('error', () => settle(false));
      // 30s — `import torch` on a cold cache can take 5-10s on macOS, longer
      // when the CPU is busy with another training run.
      setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } settle(false); }, 30_000);
    });

    if (result) TrainerHelper.pyTorchCache = true;
    return result;
  }

  async trainMicroModel(options: TrainingOptions): Promise<TrainingResult> {
    if (TrainerHelper.trainingInProgress) {
      throw new Error('A training run is already in progress on this node — refusing concurrent execution');
    }
    TrainerHelper.trainingInProgress = true;
    try {
      return await this.trainMicroModelInner(options);
    } finally {
      TrainerHelper.trainingInProgress = false;
    }
  }

  validateTrainingConfig(proposal: MutationProposal): { valid: boolean; error?: string } {
    const { hyperparams } = proposal;

    if (hyperparams.learningRate < 0.0001 || hyperparams.learningRate > 0.01)
      return { valid: false, error: 'learningRate must be between 0.0001 and 0.01' };
    if (![16, 32, 64, 128].includes(hyperparams.batchSize))
      return { valid: false, error: 'batchSize must be one of: 16, 32, 64, 128' };
    if (![64, 128, 192, 256].includes(hyperparams.hiddenDim))
      return { valid: false, error: 'hiddenDim must be one of: 64, 128, 192, 256' };
    if (hyperparams.numLayers < 2 || hyperparams.numLayers > 8)
      return { valid: false, error: 'numLayers must be between 2 and 8' };
    if (![2, 4, 8].includes(hyperparams.numHeads))
      return { valid: false, error: 'numHeads must be one of: 2, 4, 8' };
    if (!['gelu', 'silu', 'relu'].includes(hyperparams.activation))
      return { valid: false, error: "activation must be one of: gelu, silu, relu" };
    if (!['layernorm', 'rmsnorm'].includes(hyperparams.normalization))
      return { valid: false, error: "normalization must be one of: layernorm, rmsnorm" };
    if (!['xavier', 'kaiming', 'normal'].includes(hyperparams.initScheme))
      return { valid: false, error: "initScheme must be one of: xavier, kaiming, normal" };
    if (hyperparams.maxTrainSeconds < 10 || hyperparams.maxTrainSeconds > 300)
      return { valid: false, error: 'maxTrainSeconds must be between 10 and 300' };

    return { valid: true };
  }

  calculateImprovement(currentLoss: number, bestLoss: number): number {
    if (bestLoss <= 0) return 0;
    return ((bestLoss - currentLoss) / bestLoss) * 100;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Ask Ollama to unload every currently-loaded model so its weights free RAM
   * before we spawn Python + torch. Uses /api/ps to list residents, then posts
   * {model, keep_alive: 0} to /api/generate for each (Ollama interprets
   * keep_alive=0 as "unload now"). Fully best-effort: 2s total budget, every
   * error swallowed — a stale Ollama must never block training.
   */
  private async unloadOllamaModels(): Promise<void> {
    const baseUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
    const deadline = Date.now() + 2000;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(500, deadline - Date.now()));
      const listRes = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal });
      clearTimeout(timer);
      if (!listRes.ok) return;
      const listJson = (await listRes.json()) as { models?: Array<{ name?: string; model?: string }> };
      const loaded = (listJson.models ?? [])
        .map((m) => m.name ?? m.model)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
      if (loaded.length === 0) return;
      logger.log(`[trainer] unloading ${loaded.length} ollama model(s) to free RAM: ${loaded.join(', ')}`);
      await Promise.all(loaded.map(async (name) => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), Math.max(300, deadline - Date.now()));
        try {
          await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: name, keep_alive: 0, prompt: '' }),
            signal: ctl.signal,
          });
        } catch { /* ignore */ } finally { clearTimeout(t); }
      }));
    } catch { /* ignore */ }
  }

  private resolveTrainScript(): string {
    try {
      const here = moduleDir();
      // tsup bundles this file into dist/chunk-*.js; the scripts directory
      // ships as dist/scripts/. Walk up from `here` covering both dev
      // (src/modules/model) and production (dist) layouts.
      const candidates = [
        resolve(here, 'scripts/train_micro.py'),            // dist/scripts
        resolve(here, '../scripts/train_micro.py'),         // dist/./scripts
        resolve(here, '../../scripts/train_micro.py'),      // packages/node/scripts (dev)
        resolve(here, '../../../scripts/train_micro.py'),
        resolve(here, '../../../../scripts/train_micro.py'),
        resolve(process.cwd(), 'scripts/train_micro.py'),   // cwd last resort
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return candidates[0];
    } catch {
      return resolve(moduleDir(), 'scripts/train_micro.py');
    }
  }

  private async trainMicroModelInner(options: TrainingOptions): Promise<TrainingResult> {
    const {
      proposal, datasetPath, hardware,
      pythonScriptPath = this.resolveTrainScript(),
      runNumber = 1,
    } = options;

    // Training can be slow in container environments (CPU-constrained). Default: 20 min.
    const TRAINING_TIMEOUT_MS = parseInt(process.env.TRAINING_TIMEOUT_MS || '1200000', 10);

    // Best-effort: unload any model currently resident in Ollama so that
    // torch's ~600-800 MB import spike doesn't collide with qwen/llama weights
    // still pinned by KEEP_ALIVE. Runs with a tight 2s budget — if Ollama is
    // down or slow, we continue anyway; the spawn won't wait on this.
    await this.unloadOllamaModels().catch(() => { /* fire-and-forget */ });

    let killProcess: (() => void) | null = null;
    const settledHolder = { current: false };

    const trainingPromise = new Promise<TrainingResult>((res, reject) => {
      const startTime = Date.now();
      const lossCurve: number[] = [];

      logger.log(`Spawning: python3 ${pythonScriptPath}`);
      logger.log(`Training timeout: ${(TRAINING_TIMEOUT_MS / 1000).toFixed(0)}s (TRAINING_TIMEOUT_MS env var overrides)`);
      logger.log(`Script exists: ${existsSync(pythonScriptPath)}`);

      // -u forces unbuffered stdout/stderr so JSON progress lines arrive
      // immediately instead of being held in Python's 4 KB block buffer.
      // Thread-cap env vars belt-and-suspenders: train_micro.py already sets
      // these with setdefault before `import torch`, but passing them through
      // the spawn guarantees they're present even if the script is edited.
      const pythonProcess = spawn('python3', ['-u', pythonScriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OMP_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          NUMEXPR_NUM_THREADS: '1',
          VECLIB_MAXIMUM_THREADS: '1',
        },
      });

      killProcess = () => { if (!pythonProcess.killed) pythonProcess.kill('SIGTERM'); };

      const hyperparamsPayload = { ...proposal.hyperparams, dataPath: datasetPath, hardware };

      const settle = (err?: Error, result?: TrainingResult) => {
        if (settledHolder.current) return;
        settledHolder.current = true;
        killProcess = null;
        if (err) reject(err); else res(result!);
      };

      pythonProcess.on('error', (error) => {
        settle(new Error(`Failed to spawn python3: ${error.message}. Is python3 installed?`));
      });

      pythonProcess.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') logger.warn(`[trainer] stdin error: ${err.message}`);
      });

      const payload = JSON.stringify(hyperparamsPayload);
      logger.log(`Sending payload (${payload.length} bytes): dataPath=${hyperparamsPayload.dataPath}, hardware=${hyperparamsPayload.hardware}`);
      pythonProcess.stdin.write(payload);
      pythonProcess.stdin.end();

      let stdout = '';
      let stderr = '';
      let finalResult: Partial<TrainingResult> | null = null;

      pythonProcess.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.step !== undefined && parsed.loss !== undefined) lossCurve.push(parsed.loss);
            if (parsed.result) {
              finalResult = { finalLoss: parsed.result.finalLoss, valLoss: parsed.result.valLoss };
            }
          } catch { /* ignore non-JSON */ }
        }
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      pythonProcess.on('close', (code, signal) => {
        const durationMs = Date.now() - startTime;
        if (stderr.trim()) logger.warn(`[trainer] python3 stderr:\n${stderr.trim().slice(0, 2000)}`);

        if (code === null || code !== 0) {
          // code === null + SIGKILL almost always means the container's cgroup
          // OOM killer took the process — Python didn't get a chance to flush
          // any output. Call this out explicitly so operators know to bump
          // mem_limit or lower hiddenDim/batchSize instead of chasing a bug
          // in the trainer.
          const killedByOom = code === null && signal === 'SIGKILL';
          const base = stderr.trim()
            ? `Training failed (exit ${code}, signal ${signal ?? 'none'}): ${stderr.trim().slice(0, 500)}`
            : `Training process exited with code ${code ?? 'null'}, signal ${signal ?? 'none'} — no output received`;
          const errorMsg = killedByOom
            ? `${base} — likely OOM (SIGKILL by cgroup). Raise container mem_limit or lower hiddenDim/batchSize.`
            : base;
          settle(new Error(errorMsg));
          return;
        }

        if (!finalResult) {
          settle(new Error('Training completed but no result received from Python script'));
          return;
        }

        settle(undefined, {
          runNumber, finalLoss: finalResult.finalLoss ?? 0, valLoss: finalResult.valLoss ?? 0,
          improvementPercent: 0, durationMs, config: proposal.hyperparams, lossCurve, hardwareUsed: hardware,
        });
      });
    });

    const timeoutPromise = new Promise<never>((_res, reject) => {
      const timeoutHandle = setTimeout(() => {
        // Mark settled BEFORE killing so the close-event handler is a no-op.
        settledHolder.current = true;
        if (killProcess) { killProcess(); killProcess = null; }
        reject(new Error(`Training timed out after ${TRAINING_TIMEOUT_MS / 1000}s`));
      }, TRAINING_TIMEOUT_MS);
      trainingPromise.finally(() => clearTimeout(timeoutHandle));
    });

    return await Promise.race([trainingPromise, timeoutPromise]);
  }
}

// Backward-compatible standalone exports (used by work-order.execution.ts, agent-loop.ts, heartbeat.ts)
const _trainerInstance = new TrainerHelper();
export const isPyTorchAvailable = () => _trainerInstance.isPyTorchAvailable();
export const trainMicroModel = (options: TrainingOptions) => _trainerInstance.trainMicroModel(options);
export const validateTrainingConfig = (proposal: MutationProposal) => _trainerInstance.validateTrainingConfig(proposal);
export const calculateImprovement = (currentLoss: number, bestLoss: number) => _trainerInstance.calculateImprovement(currentLoss, bestLoss);
