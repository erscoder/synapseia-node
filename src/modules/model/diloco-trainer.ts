/**
 * DiLoCo TypeScript wrapper
 * Spawns diloco_train.py and captures results from stdout JSON lines.
 */

import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { statSync } from 'fs';

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
  /** HuggingFace model ID, e.g. "Qwen/Qwen2.5-7B" */
  modelId: string;
  /** Path to existing LoRA adapter weights (undefined for first round) */
  adapterPath?: string;
  /** Local path to training corpus */
  datasetPath: string;
  /** Number of inner-loop steps per outer round */
  innerSteps: number;
  /** Training hyperparameters */
  hyperparams: DiLoCoHyperparams;
  /** Compute backend */
  hardware: 'cpu' | 'mps' | 'cuda';
  /** Use a tiny model for testing instead of the full 7B */
  testMode?: boolean;
  /** Custom path to the Python script (for testing) */
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
  /** Local path to the SVD-compressed gradient file (.pt) */
  gradientPath: string;
  /** Size of the gradient file in bytes */
  gradientSizeBytes: number;
}

/**
 * Run the DiLoCo inner training loop by spawning diloco_train.py.
 *
 * Emits JSON progress lines while training, then a final result line.
 */
export async function runDiLoCoInnerLoop(
  config: DiLoCoConfig,
  onProgress?: (update: DiLoCoProgressUpdate) => void,
): Promise<DiLoCoResult> {
  const scriptPath =
    config.pythonScriptPath ??
    resolve(process.cwd(), 'scripts/diloco_train.py');

  const startTime = Date.now();

  const payload = {
    modelId: config.modelId,
    adapterPath: config.adapterPath ?? null,
    datasetPath: config.datasetPath,
    innerSteps: config.innerSteps,
    hyperparams: config.hyperparams,
    hardware: config.hardware,
    testMode: config.testMode ?? false,
  };

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let finalResult: DiLoCoResult | null = null;

    // Send config via stdin
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;

          if (parsed['error']) {
            reject(new Error(String(parsed['error'])));
            return;
          }

          if (parsed['step'] !== undefined && parsed['loss'] !== undefined) {
            if (onProgress) {
              onProgress({
                step: parsed['step'] as number,
                loss: parsed['loss'] as number,
                lr: (parsed['lr'] as number) ?? 0,
              });
            }
          }

          if (parsed['result']) {
            const r = parsed['result'] as Record<string, unknown>;
            const gradientPath = String(r['gradientPath']);

            let gradientSizeBytes = 0;
            try {
              gradientSizeBytes = statSync(gradientPath).size;
            } catch {
              gradientSizeBytes = 0;
            }

            finalResult = {
              finalLoss: Number(r['finalLoss']) || 0,
              valLoss: Number(r['valLoss']) || 0,
              innerSteps: Number(r['innerSteps']) || config.innerSteps,
              durationMs: Date.now() - startTime,
              gradientPath,
              gradientSizeBytes,
            };
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `diloco_train.py exited with code ${code}: ${stderr || 'unknown error'}`,
          ),
        );
        return;
      }
      if (!finalResult) {
        reject(
          new Error('DiLoCo training completed but no result received'),
        );
        return;
      }
      resolve(finalResult);
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn diloco_train.py: ${err.message}`));
    });
  });
}

/**
 * Injectable NestJS wrapper around runDiLoCoInnerLoop.
 */
@Injectable()
export class DiLoCoTrainerHelper {
  runDiLoCoInnerLoop(
    config: DiLoCoConfig,
    onProgress?: (update: DiLoCoProgressUpdate) => void,
  ): Promise<DiLoCoResult> {
    return runDiLoCoInnerLoop(config, onProgress);
  }
}

export const _test = {
  runDiLoCoInnerLoop,
};
