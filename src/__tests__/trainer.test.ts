import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { trainMicroModel, validateTrainingConfig, calculateImprovement, _test, type TrainingOptions } from '../modules/model/trainer.js';
import type { MutationProposal } from '../modules/model/mutation-engine.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// ESM-compatible mock: declare before jest.mock so factory can reference it
const mockSpawn: any = jest.fn();

// Mock child_process
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

describe('Trainer', () => {
  const mockProposal: MutationProposal = {
    model: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
    type: 'explore',
    baseExperimentId: null,
    reasoning: 'Test mutation',
    hyperparams: {
      learningRate: 0.001,
      batchSize: 32,
      hiddenDim: 128,
      numLayers: 4,
      numHeads: 4,
      activation: 'gelu',
      normalization: 'layernorm',
      initScheme: 'xavier',
      warmupSteps: 100,
      weightDecay: 0.01,
      maxTrainSeconds: 30,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('trainMicroModel', () => {
    it.skip('should execute Python script and return training result', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
        runNumber: 1,
      };

      const promise = trainMicroModel(options);

      // Simulate Python output
      setTimeout(() => {
        mockProcess.stdout.emit('data', JSON.stringify({ step: 10, loss: 4.5, lr: 0.001 }) + '\n');
        mockProcess.stdout.emit('data', JSON.stringify({ step: 20, loss: 4.2, lr: 0.001 }) + '\n');
        mockProcess.stdout.emit('data', JSON.stringify({ result: { finalLoss: 4.0, valLoss: 4.1, steps: 100, durationMs: 25000 } }) + '\n');
        mockProcess.emit('close', 0);
      }, 10);

      const result = await promise;

      expect(result.runNumber).toBe(1);
      expect(result.finalLoss).toBe(4.0);
      expect(result.valLoss).toBe(4.1);
      expect(result.hardwareUsed).toBe('cpu');
      expect(result.lossCurve).toEqual([4.5, 4.2]);
      expect(result.config).toEqual(mockProposal.hyperparams);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it.skip('should use GPU when specified', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'gpu',
        runNumber: 2,
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.stdout.emit('data', JSON.stringify({ result: { finalLoss: 3.5, valLoss: 3.6, steps: 200, durationMs: 30000 } }) + '\n');
        mockProcess.emit('close', 0);
      }, 10);

      const result = await promise;

      expect(result.hardwareUsed).toBe('gpu');
      expect(result.runNumber).toBe(2);
    });

    it.skip('should reject when Python process exits with error code', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.stderr.emit('data', 'Python error: Module not found');
        mockProcess.emit('close', 1);
      }, 10);

      await expect(promise).rejects.toThrow('Training failed with exit code 1');
    });

    it.skip('should reject when no result is received from Python', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.stdout.emit('data', JSON.stringify({ step: 10, loss: 4.5 }) + '\n');
        mockProcess.emit('close', 0);
      }, 10);

      await expect(promise).rejects.toThrow('Training completed but no result received');
    });

    it.skip('should reject when Python process fails to spawn', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.emit('error', new Error('ENOENT: python3 not found'));
      }, 10);

      await expect(promise).rejects.toThrow('Failed to spawn Python process');
    });

    it.skip('should handle multiple progress updates', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.stdout.emit('data', 
          JSON.stringify({ step: 10, loss: 5.0 }) + '\n' +
          JSON.stringify({ step: 20, loss: 4.8 }) + '\n' +
          JSON.stringify({ step: 30, loss: 4.6 }) + '\n' +
          JSON.stringify({ step: 40, loss: 4.4 }) + '\n' +
          JSON.stringify({ result: { finalLoss: 4.2, valLoss: 4.3, steps: 50, durationMs: 20000 } }) + '\n'
        );
        mockProcess.emit('close', 0);
      }, 10);

      const result = await promise;

      expect(result.lossCurve).toEqual([5.0, 4.8, 4.6, 4.4]);
      expect(result.finalLoss).toBe(4.2);
    });

    it.skip('should ignore non-JSON lines in stdout', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.stdout.emit('data', 'Loading model...\n');
        mockProcess.stdout.emit('data', JSON.stringify({ step: 10, loss: 4.5 }) + '\n');
        mockProcess.stdout.emit('data', 'Warning: some deprecation warning\n');
        mockProcess.stdout.emit('data', JSON.stringify({ result: { finalLoss: 4.0, valLoss: 4.1, steps: 100, durationMs: 25000 } }) + '\n');
        mockProcess.emit('close', 0);
      }, 10);

      const result = await promise;

      expect(result.lossCurve).toEqual([4.5]);
      expect(result.finalLoss).toBe(4.0);
    });

    it.skip('should use custom python script path', async () => {
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const customPath = '/custom/path/train.py';
      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
        pythonScriptPath: customPath,
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.stdout.emit('data', JSON.stringify({ result: { finalLoss: 3.0, valLoss: 3.1, steps: 100, durationMs: 20000 } }) + '\n');
        mockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(spawn).toHaveBeenCalledWith('python3', [customPath], expect.any(Object));
    });

    it.skip('should send hyperparams to Python via stdin', async () => {
      const mockProcess = new EventEmitter() as any;
      const writeMock = jest.fn();
      const endMock = jest.fn();
      mockProcess.stdin = { write: writeMock, end: endMock };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValue(mockProcess);

      const options: TrainingOptions = {
        proposal: mockProposal,
        datasetPath: './data/test.txt',
        hardware: 'cpu',
      };

      const promise = trainMicroModel(options);

      setTimeout(() => {
        mockProcess.stdout.emit('data', JSON.stringify({ result: { finalLoss: 4.0, valLoss: 4.1, steps: 100, durationMs: 25000 } }) + '\n');
        mockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(writeMock).toHaveBeenCalled();
      const sentData = writeMock.mock.calls[0][0] as string;
      const parsed = JSON.parse(sentData);
      expect(parsed.learningRate).toBe(0.001);
      expect(parsed.batchSize).toBe(32);
      expect(parsed.dataPath).toBe('./data/test.txt');
      expect(parsed.hardware).toBe('cpu');
    });
  });

  describe('validateTrainingConfig', () => {
    it('should validate correct config', () => {
      const result = validateTrainingConfig(mockProposal);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid learningRate (too high)', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, learningRate: 0.1 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('learningRate');
    });

    it('should reject invalid learningRate (too low)', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, learningRate: 0.00001 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('learningRate');
    });

    it('should reject invalid batchSize', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, batchSize: 50 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('batchSize');
    });

    it('should reject invalid hiddenDim', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, hiddenDim: 100 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('hiddenDim');
    });

    it('should reject invalid numLayers (too high)', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, numLayers: 10 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('numLayers');
    });

    it('should reject invalid numLayers (too low)', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, numLayers: 1 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('numLayers');
    });

    it('should reject invalid numHeads', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, numHeads: 6 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('numHeads');
    });

    it('should reject invalid activation', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, activation: 'sigmoid' as any },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('activation');
    });

    it('should reject invalid normalization', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, normalization: 'batchnorm' as any },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('normalization');
    });

    it('should reject invalid initScheme', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, initScheme: 'he' as any },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('initScheme');
    });

    it('should reject invalid maxTrainSeconds (too high)', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, maxTrainSeconds: 1000 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('maxTrainSeconds');
    });

    it('should reject invalid maxTrainSeconds (too low)', () => {
      const invalidProposal = {
        ...mockProposal,
        hyperparams: { ...mockProposal.hyperparams, maxTrainSeconds: 5 },
      };
      const result = validateTrainingConfig(invalidProposal);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('maxTrainSeconds');
    });

    it('should accept boundary values', () => {
      const boundaryProposal = {
        ...mockProposal,
        hyperparams: {
          ...mockProposal.hyperparams,
          learningRate: 0.0001,
          numLayers: 2,
          maxTrainSeconds: 10,
        },
      };
      const result = validateTrainingConfig(boundaryProposal);
      expect(result.valid).toBe(true);
    });

    it('should accept all valid activations', () => {
      const activations = ['gelu', 'silu', 'relu'] as const;
      for (const activation of activations) {
        const proposal: MutationProposal = {
          ...mockProposal,
          hyperparams: { ...mockProposal.hyperparams, activation },
        };
        const result = validateTrainingConfig(proposal);
        expect(result.valid).toBe(true);
      }
    });

    it('should accept all valid normalizations', () => {
      const normalizations = ['layernorm', 'rmsnorm'] as const;
      for (const normalization of normalizations) {
        const proposal: MutationProposal = {
          ...mockProposal,
          hyperparams: { ...mockProposal.hyperparams, normalization },
        };
        const result = validateTrainingConfig(proposal);
        expect(result.valid).toBe(true);
      }
    });

    it('should accept all valid initSchemes', () => {
      const schemes = ['xavier', 'kaiming', 'normal'] as const;
      for (const initScheme of schemes) {
        const proposal: MutationProposal = {
          ...mockProposal,
          hyperparams: { ...mockProposal.hyperparams, initScheme },
        };
        const result = validateTrainingConfig(proposal);
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('calculateImprovement', () => {
    it('should calculate positive improvement', () => {
      const improvement = calculateImprovement(3.5, 4.0);
      expect(improvement).toBe(12.5);
    });

    it('should calculate negative improvement (regression)', () => {
      const improvement = calculateImprovement(4.5, 4.0);
      expect(improvement).toBe(-12.5);
    });

    it('should return 0 when bestLoss is 0', () => {
      const improvement = calculateImprovement(3.5, 0);
      expect(improvement).toBe(0);
    });

    it('should return 0 when bestLoss is negative', () => {
      const improvement = calculateImprovement(3.5, -1);
      expect(improvement).toBe(0);
    });

    it('should handle equal losses', () => {
      const improvement = calculateImprovement(4.0, 4.0);
      expect(improvement).toBe(0);
    });

    it('should calculate large improvements', () => {
      const improvement = calculateImprovement(2.0, 10.0);
      expect(improvement).toBe(80);
    });
  });

  describe('_test exports', () => {
    it('should export calculateImprovement', () => {
      expect(_test.calculateImprovement).toBe(calculateImprovement);
    });
  });
});
