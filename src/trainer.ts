/**
 * Micro-trainer TypeScript wrapper
 * Executes Python training script and captures results
 */

import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { resolve } from 'path';
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
 * Spawns Python script and captures results from stdout
 */
export async function trainMicroModel(options: TrainingOptions): Promise<TrainingResult> {
  const {
    proposal,
    datasetPath,
    hardware,
    pythonScriptPath = resolve(process.cwd(), 'scripts/train_micro.py'),
    runNumber = 1,
  } = options;

  const startTime = Date.now();
  const lossCurve: number[] = [];

  // Prepare hyperparams payload for Python script
  const hyperparamsPayload = {
    ...proposal.hyperparams,
    dataPath: datasetPath,
    hardware,
  };

  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', [pythonScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finalResult: Partial<TrainingResult> | null = null;

    // Send hyperparams to Python script via stdin
    pythonProcess.stdin.write(JSON.stringify(hyperparamsPayload));
    pythonProcess.stdin.end();

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

      if (code !== 0) {
        reject(new Error(`Training failed with exit code ${code}: ${stderr || 'Unknown error'}`));
        return;
      }

      if (!finalResult) {
        reject(new Error('Training completed but no result received from Python script'));
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

      resolve(result);
    });

    // Handle process errors (spawn failures, etc.)
    pythonProcess.on('error', (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });
  });
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
