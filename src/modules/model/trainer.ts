/**
 * Micro-trainer — executes Python training script and captures results
 */

import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import logger from '../../utils/logger';
import type { MutationProposal } from './mutation-engine';

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

  private resolveTrainScript(): string {
    try {
      // Works in both CJS (Jest) and ESM (tsup bundles __dirname shim)
      const moduleDir = resolve(process.cwd(), 'dist');
      const candidates = [
        resolve(moduleDir, '../scripts/train_micro.py'),
        resolve(moduleDir, '../../scripts/train_micro.py'),
        resolve(moduleDir, '../../../scripts/train_micro.py'),
        resolve(moduleDir, '../../../../scripts/train_micro.py'),
        resolve(process.cwd(), 'scripts/train_micro.py'),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return candidates[0];
    } catch {
      return resolve(process.cwd(), 'scripts/train_micro.py');
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
      const pythonProcess = spawn('python3', ['-u', pythonScriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
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

      pythonProcess.on('close', (code) => {
        const durationMs = Date.now() - startTime;
        if (stderr.trim()) logger.warn(`[trainer] python3 stderr:\n${stderr.trim().slice(0, 2000)}`);

        if (code === null || code !== 0) {
          const errorMsg = stderr.trim()
            ? `Training failed (exit ${code}): ${stderr.trim().slice(0, 500)}`
            : `Training process exited with code ${code ?? 'null'} — no output received`;
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
