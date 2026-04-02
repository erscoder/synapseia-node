/**
 * Micro-trainer TypeScript wrapper
 * Executes Python training script and captures results
 */

import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../../utils/logger.js';
import type { MutationProposal } from './mutation-engine.js';

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

/**
 * Train a micro-transformer with given hyperparameters
 * Spawns Python script and captures results from stdout.
 * Uses Promise.race to enforce a configurable timeout.
 */
/**
 * Resolve path to train_micro.py relative to this module's location.
 * Works both in dev (src/) and production (dist/) since the scripts/
 * folder is copied next to the compiled output.
 *
 * Resolution order:
 *  1. Next to dist/index.js → <distDir>/../../scripts/train_micro.py (monorepo)
 *  2. Sibling scripts/ dir  → <moduleDir>/../../scripts/train_micro.py
 *  3. Fallback to process.cwd()
 */
function resolveTrainScript(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // Resolution order (most specific first):
    // 1. dist/scripts/ — tsup copies scripts/ there at build time
    // 2. Walk up from module dir (monorepo dev setup)
    // 3. process.cwd() fallback
    const candidates = [
      resolve(moduleDir, '../scripts/train_micro.py'),    // dist/scripts/ (copied by tsup)
      resolve(moduleDir, '../../scripts/train_micro.py'),
      resolve(moduleDir, '../../../scripts/train_micro.py'),
      resolve(moduleDir, '../../../../scripts/train_micro.py'),
      resolve(process.cwd(), 'scripts/train_micro.py'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return candidates[0]; // fall back even if not found — error will be thrown at spawn time
  } catch {
    return resolve(process.cwd(), 'scripts/train_micro.py');
  }
}

/**
 * Check if PyTorch is available (python3 + torch importable).
 * TRAINING WOs require PyTorch — nodes without it should not accept them.
 */
export async function isPyTorchAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['-c', 'import torch; print(torch.__version__)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    // Timeout: 5s
    setTimeout(() => { proc.kill(); resolve(false); }, 5000);
  });
}

export async function trainMicroModel(options: TrainingOptions): Promise<TrainingResult> {
  const {
    proposal,
    datasetPath,
    hardware,
    pythonScriptPath = resolveTrainScript(),
    runNumber = 1,
  } = options;

  // Configurable timeout: env TRAINING_TIMEOUT_MS, default 10 minutes = 600000ms
  const TRAINING_TIMEOUT_MS = parseInt(process.env.TRAINING_TIMEOUT_MS || '600000', 10);

  /**
   * Inner promise that settles when the Python subprocess completes.
   * Resolves with TrainingResult on success, rejects on failure.
   */
  let killProcess: (() => void) | null = null;
  const settledHolder: { current: boolean } = { current: false };

  const trainingPromise = new Promise<TrainingResult>((resolve, reject) => {
    const startTime = Date.now();
    const lossCurve: number[] = [];

    logger.log(`[trainer] Spawning: python3 ${pythonScriptPath}`);
    logger.log(`[trainer] Script exists: ${existsSync(pythonScriptPath)}`);

    const pythonProcess = spawn('python3', [pythonScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Expose kill function so the timeout handler can stop the subprocess
    killProcess = () => {
      if (!pythonProcess.killed) {
        pythonProcess.kill('SIGTERM');
      }
    };

    // Prepare hyperparams payload for Python script
    const hyperparamsPayload = {
      ...proposal.hyperparams,
      dataPath: datasetPath,
      hardware,
    };

    const settle = (err?: Error, result?: TrainingResult) => {
      if (settledHolder.current) return;
      settledHolder.current = true;
      killProcess = null; // prevent timeout handler from killing after normal completion
      if (err) reject(err);
      else resolve(result!);
    };

    // Handle spawn errors (python3 binary not found, etc.)
    pythonProcess.on('error', (error) => {
      settle(new Error(`Failed to spawn python3: ${error.message}. Is python3 installed?`));
    });

    // Send hyperparams to Python script via stdin
    pythonProcess.stdin.write(JSON.stringify(hyperparamsPayload));
    pythonProcess.stdin.end();

    let stdout = '';
    let stderr = '';
    let finalResult: Partial<TrainingResult> | null = null;

    // Capture stdout (JSON lines)
    pythonProcess.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);

          // Progress update: { step, loss, lr }
          if (parsed.step !== undefined && parsed.loss !== undefined) {
            lossCurve.push(parsed.loss);
          }

          // Final result: { result: { finalLoss, valLoss, steps, durationMs } }
          if (parsed.result) {
            finalResult = {
              finalLoss: parsed.result.finalLoss,
              valLoss: parsed.result.valLoss,
            };
          }
        } catch {
          // Ignore non-JSON lines (logs, warnings, etc.)
        }
      }

      stdout += data.toString();
    });

    // Capture stderr for error reporting
    pythonProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle process completion
    pythonProcess.on('close', (code) => {
      const durationMs = Date.now() - startTime;

      // Always log stderr (contains Python tracebacks, import errors, etc.)
      if (stderr.trim()) {
        logger.warn(`[trainer] python3 stderr:\n${stderr.trim().slice(0, 2000)}`);
      }

      // code null = killed by signal (SIGKILL/SIGTERM) before timeout fires
      // code !== 0 = Python script returned non-zero exit
      // Both are failures. code === 0 = success.
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

      // Calculate improvement (placeholder - will be calculated against best known loss)
      const improvementPercent = 0; // This will be set by the caller

      const result: TrainingResult = {
        runNumber,
        finalLoss: finalResult.finalLoss ?? 0,
        valLoss: finalResult.valLoss ?? 0,
        improvementPercent,
        durationMs,
        config: proposal.hyperparams,
        lossCurve,
        hardwareUsed: hardware,
      };

      settle(undefined, result);
    });
  });

  /**
   * Timeout promise that rejects after TRAINING_TIMEOUT_MS.
   * Kills the Python subprocess if it fires before training completes.
   */
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      // Kill the subprocess if it's still running
      if (killProcess) {
        killProcess();
        killProcess = null;
      }
      reject(new Error(`Training timed out after ${TRAINING_TIMEOUT_MS / 1000}s`));
    }, TRAINING_TIMEOUT_MS);

    // Prevent unhandled rejection warning — clear handle once training resolves first
    trainingPromise.finally(() => clearTimeout(timeoutHandle));
  });

  return await Promise.race([trainingPromise, timeoutPromise]);
}

/**
 * Validate that the training configuration is valid
 */
export function validateTrainingConfig(proposal: MutationProposal): { valid: boolean; error?: string } {
  const { hyperparams } = proposal;

  // Validate learning rate
  if (hyperparams.learningRate < 0.0001 || hyperparams.learningRate > 0.01) {
    return { valid: false, error: 'learningRate must be between 0.0001 and 0.01' };
  }

  // Validate batch size
  const validBatchSizes = [16, 32, 64, 128];
  if (!validBatchSizes.includes(hyperparams.batchSize)) {
    return { valid: false, error: `batchSize must be one of: ${validBatchSizes.join(', ')}` };
  }

  // Validate hidden dimension
  const validHiddenDims = [64, 128, 192, 256];
  if (!validHiddenDims.includes(hyperparams.hiddenDim)) {
    return { valid: false, error: `hiddenDim must be one of: ${validHiddenDims.join(', ')}` };
  }

  // Validate numLayers
  if (hyperparams.numLayers < 2 || hyperparams.numLayers > 8) {
    return { valid: false, error: 'numLayers must be between 2 and 8' };
  }

  // Validate numHeads
  const validNumHeads = [2, 4, 8];
  if (!validNumHeads.includes(hyperparams.numHeads)) {
    return { valid: false, error: `numHeads must be one of: ${validNumHeads.join(', ')}` };
  }

  // Validate activation
  const validActivations = ['gelu', 'silu', 'relu'];
  if (!validActivations.includes(hyperparams.activation)) {
    return { valid: false, error: `activation must be one of: ${validActivations.join(', ')}` };
  }

  // Validate normalization
  const validNormalizations = ['layernorm', 'rmsnorm'];
  if (!validNormalizations.includes(hyperparams.normalization)) {
    return { valid: false, error: `normalization must be one of: ${validNormalizations.join(', ')}` };
  }

  // Validate initScheme
  const validInitSchemes = ['xavier', 'kaiming', 'normal'];
  if (!validInitSchemes.includes(hyperparams.initScheme)) {
    return { valid: false, error: `initScheme must be one of: ${validInitSchemes.join(', ')}` };
  }

  // Validate maxTrainSeconds
  if (hyperparams.maxTrainSeconds < 10 || hyperparams.maxTrainSeconds > 600) {
    return { valid: false, error: 'maxTrainSeconds must be between 10 and 600' };
  }

  return { valid: true };
}

/**
 * Calculate improvement percentage vs best known loss
 */
export function calculateImprovement(currentLoss: number, bestLoss: number): number {
  if (bestLoss <= 0) return 0;
  return ((bestLoss - currentLoss) / bestLoss) * 100;
}

// Export for testing
export const _test = {
  calculateImprovement,
};

/**
 * Injectable helper class — wraps trainer functions for NestJS DI
 */
@Injectable()
export class TrainerHelper {
  trainMicroModel(options: TrainingOptions): Promise<TrainingResult> {
    return trainMicroModel(options);
  }

  validateTrainingConfig(proposal: MutationProposal): { valid: boolean; error?: string } {
    return validateTrainingConfig(proposal);
  }

  calculateImprovement(currentLoss: number, bestLoss: number): number {
    return calculateImprovement(currentLoss, bestLoss);
  }
}
