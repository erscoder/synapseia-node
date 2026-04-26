/**
 * DiLoCo TypeScript wrapper
 * Spawns diloco_train.py and captures results from stdout JSON lines.
 */

import { Injectable } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync } from 'fs';

/**
 * Directory of THIS bundled module. See trainer.ts for the rationale —
 * Tauri spawns the node binary with cwd='/', so a `resolve('.')` fallback
 * is wrong in production. The `import.meta.url` literal lives only inside
 * a `new Function(...)` body so ts-jest CJS transpilation can't choke on it.
 */
function moduleDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const importMetaUrl = new Function('return import.meta.url')() as string;
    return dirname(fileURLToPath(importMetaUrl));
  } catch {
    throw new Error(
      '[diloco-trainer] Cannot resolve module directory: __dirname is undefined and import.meta.url is unavailable',
    );
  }
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
  async runDiLoCoInnerLoop(
    config: DiLoCoConfig,
    onProgress?: (update: DiLoCoProgressUpdate) => void,
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    statFn: StatFn = (p) => statSync(p) as { size: number },
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

    return new Promise((res, reject) => {
      const proc = spawnFn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      let finalResult: DiLoCoResult | null = null;
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill?.('SIGTERM');
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

      proc.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        if (timedOut) return;
        if (code !== 0) { reject(new Error(`diloco_train.py exited with code ${code}: ${stderr || 'unknown error'}`)); return; }
        if (!finalResult) { reject(new Error('DiLoCo training completed but no result received')); return; }
        res(finalResult);
      });

      proc.on('error', (err) => { clearTimeout(timeoutHandle); reject(new Error(`Failed to spawn diloco_train.py: ${err.message}`)); });
    });
  }
}

// Backward-compatible standalone export
const _dilocoInstance = new DiLoCoTrainerHelper();
export const runDiLoCoInnerLoop = (
  config: DiLoCoConfig, onProgress?: (update: DiLoCoProgressUpdate) => void,
  spawnFn?: SpawnFn, statFn?: StatFn,
) => _dilocoInstance.runDiLoCoInnerLoop(config, onProgress, spawnFn, statFn);
