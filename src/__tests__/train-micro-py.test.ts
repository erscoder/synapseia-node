import { describe, it, expect, beforeAll } from '@jest/globals';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

interface ScriptResult {
  progress: Array<{ step: number; loss: number; lr: number }>;
  finalResult: any;
  exitCode: number | null;
  stderr: string;
}

interface RawResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

describe('train_micro.py', () => {
  const scriptPath = resolve(process.cwd(), 'scripts/train_micro.py');
  const sampleDataPath = resolve(process.cwd(), 'data/astro-sample.txt');

  beforeAll(() => {
    if (!existsSync(scriptPath)) {
      throw new Error(`Python script not found at ${scriptPath}`);
    }
  });

  it('should exist and be a valid Python file', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('should process valid JSON input and produce output', async () => {
    const input = {
      learningRate: 0.001,
      batchSize: 16,
      hiddenDim: 64,
      numLayers: 2,
      numHeads: 2,
      activation: 'gelu',
      normalization: 'layernorm',
      initScheme: 'xavier',
      warmupSteps: 10,
      weightDecay: 0.01,
      maxTrainSeconds: 5,
      dataPath: sampleDataPath,
      hardware: 'cpu',
    };

    const result = await runPythonScript(scriptPath, input);

    expect(result.progress.length).toBeGreaterThan(0);
    expect(result.finalResult).not.toBeNull();
    expect(result.finalResult.result.finalLoss).toBeGreaterThan(0);
    expect(result.finalResult.result.valLoss).toBeGreaterThan(0);
    expect(result.finalResult.result.steps).toBeGreaterThan(0);
    expect(result.finalResult.result.durationMs).toBeGreaterThan(0);
    expect(result.finalResult.result.params).toBeGreaterThan(0);
    expect(result.finalResult.result.vocabSize).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  }, 30000);

  it('should handle different hyperparameter configurations', async () => {
    const configs = [
      { activation: 'relu', normalization: 'layernorm', initScheme: 'kaiming' },
      { activation: 'silu', normalization: 'rmsnorm', initScheme: 'normal' },
    ];

    for (const config of configs) {
      const input = {
        learningRate: 0.001,
        batchSize: 16,
        hiddenDim: 64,
        numLayers: 2,
        numHeads: 2,
        ...config,
        warmupSteps: 10,
        weightDecay: 0.01,
        maxTrainSeconds: 3,
        dataPath: sampleDataPath,
        hardware: 'cpu',
      };

      const result = await runPythonScript(scriptPath, input);
      expect(result.finalResult).not.toBeNull();
      expect(result.exitCode).toBe(0);
    }
  }, 60000);

  it('should handle invalid JSON input gracefully', async () => {
    const result = await runPythonScriptRaw(scriptPath, 'invalid json{');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('error');
  }, 10000);

  it('should use embedded sample data when file does not exist', async () => {
    const input = {
      learningRate: 0.001,
      batchSize: 16,
      hiddenDim: 64,
      numLayers: 2,
      numHeads: 2,
      activation: 'gelu',
      normalization: 'layernorm',
      initScheme: 'xavier',
      warmupSteps: 10,
      weightDecay: 0.01,
      maxTrainSeconds: 3,
      dataPath: '/nonexistent/path/data.txt',
      hardware: 'cpu',
    };

    const result = await runPythonScript(scriptPath, input);
    expect(result.finalResult).not.toBeNull();
    expect(result.exitCode).toBe(0);
  }, 30000);
});

function runPythonScript(scriptPath: string, input: unknown): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const progress: Array<{ step: number; loss: number; lr: number }> = [];
    let finalResult: any = null;
    let stderr = '';

    pythonProcess.stdin.write(JSON.stringify(input));
    pythonProcess.stdin.end();

    pythonProcess.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.step !== undefined) {
            progress.push(parsed);
          } else if (parsed.result) {
            finalResult = parsed;
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    });

    pythonProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      resolve({ progress, finalResult, exitCode: code, stderr });
    });

    pythonProcess.on('error', (err) => {
      reject(err);
    });
  });
}

function runPythonScriptRaw(scriptPath: string, rawInput: string): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdin.write(rawInput);
    pythonProcess.stdin.end();

    pythonProcess.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      resolve({ exitCode: code, stderr, stdout });
    });

    pythonProcess.on('error', (err) => {
      reject(err);
    });
  });
}
