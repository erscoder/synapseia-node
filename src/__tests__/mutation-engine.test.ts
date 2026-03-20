import { describe, it, expect, beforeEach } from '@jest/globals';
import { proposeMutation, _test } from '../modules/model/helpers/mutation-engine.js';
import type { Experiment } from '../types.js';

// Mock llm-provider
jest.mock('../modules/llm/helpers/llm-provider.js', () => ({
  generateLLM: jest.fn() as any,
}));

import { generateLLM } from '../modules/llm/helpers/llm-provider.js';

describe('Mutation Engine', () => {
  beforeEach(() => {
    (generateLLM as jest.Mock as any).mockReturnValue(Promise.resolve(''));
    jest.clearAllMocks();
  });

  describe('proposeMutation', () => {
    it('should return default config when no experiments', async () => {
      const proposal = await proposeMutation([], 0, ['cpu']);

      expect(proposal.type).toBe('explore');
      expect(proposal.baseExperimentId).toBeNull();
      expect(proposal.hyperparams).toBeDefined();
      expect(proposal.hyperparams.learningRate).toBe(0.001);
      expect(proposal.hyperparams.maxTrainSeconds).toBe(120);
      expect(proposal.reasoning).toContain('Starting with default');
    });

    it('should return default with 300s for GPU hardware', async () => {
      const proposal = await proposeMutation([], 0, ['cpu', 'gpu']);

      expect(proposal.hyperparams.maxTrainSeconds).toBe(300);
    });

    it('should call generateLLM with built prompt', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
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
          maxTrainSeconds: 120,
        },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
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
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(generateLLM).toHaveBeenCalled();
      const [, prompt] = (generateLLM as jest.Mock).mock.calls[0];
      expect(prompt).toContain('best loss so far');
      expect(prompt).toContain('3.5000');
    });

    it('should clamp learningRate within range', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.1,  // Too high
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.learningRate).toBe(0.01);  // Clamped to max
    });

    it('should clamp learningRate minimum', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.00001,  // Too low
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.learningRate).toBe(0.0001);  // Clamped to min
    });

    it('should round batchSize to valid values', async () => {
      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 45,  // Not standard
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([], 0, ['cpu']);

      expect(proposal.hyperparams.batchSize).toBe(32);  // 45 → 32
    });

    it('should round hiddenDim to valid values', async () => {
      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 140,  // Not standard
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([], 0, ['cpu']);

      expect(proposal.hyperparams.hiddenDim).toBe(128);  // 140 → 128
    });

    it('should clamp numLayers within range', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 15,  // Too many
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.numLayers).toBe(8);  // Clamped to max
    });

    it('should throw on invalid JSON response', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockRejectedValue(new Error('Failed to parse JSON'));

      await expect(proposeMutation([mockExp], 3.5, ['cpu'])).rejects.toThrow('Failed to parse JSON');
    });

    it('should accept valid initScheme: normal', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'normal',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.initScheme).toBe('normal');
    });

    it('should accept valid activation: silu', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'silu',
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.activation).toBe('silu');
    });

    it('should accept valid activation: relu', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'relu',
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.activation).toBe('relu');
    });

    it('should accept valid normalization: rmsnorm', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'rmsnorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.normalization).toBe('rmsnorm');
    });

    it('should accept valid initScheme: kaiming', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'kaiming',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.initScheme).toBe('kaiming');
    });

    it('should default to valid values for missing hyperparams', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {},  // Missing all
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.learningRate).toBe(0.001);  // Default
      expect(proposal.hyperparams.batchSize).toBe(32);  // Default
      expect(proposal.hyperparams.hiddenDim).toBe(128);  // Default
      expect(proposal.hyperparams.activation).toBe('gelu');  // Default
    });

    it('should validate activation options', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'invalid',  // Falls back to gelu
            normalization: 'layernorm',
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.activation).toBe('gelu');  // Fallback
    });

    it('should validate normalization options', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'explore',
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'invalid',  // Falls back to layernorm
            initScheme: 'xavier',
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.hyperparams.normalization).toBe('layernorm');  // Fallback
    });

    it('should validate initScheme options', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'exp:lore',  // Invalid type, defaults to explore
          baseExperimentId: null,
          hyperparams: {
            learningRate: 0.001,
            batchSize: 32,
            hiddenDim: 128,
            numLayers: 4,
            numHeads: 4,
            activation: 'gelu',
            normalization: 'layernorm',
            initScheme: 'invalid',  // Falls back to xavier
            warmupSteps: 100,
            weightDecay: 0.01,
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.type).toBe('explore');  // Type fixed
      expect(proposal.hyperparams.initScheme).toBe('xavier');  // Fallback
    });

    it('should set baseExperimentId from response', async () => {
      const mockExp: Experiment = {
        id: 'exp1',
        model: 'test',
        hyperparams: { learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4, numHeads: 4, activation: "gelu", normalization: "layernorm", initScheme: "xavier", warmupSteps: 100, weightDecay: 0.01, maxTrainSeconds: 120 },
        valLoss: 3.5,
        status: 'completed',
      };

      (generateLLM as any).mockResolvedValue(
        JSON.stringify({
          type: 'improve',
          baseExperimentId: 'exp1',
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
            maxTrainSeconds: 120,
          },
          reasoning: 'Test',
        })
      );

      const proposal = await proposeMutation([mockExp], 3.5, ['cpu']);

      expect(proposal.type).toBe('improve');
      expect(proposal.baseExperimentId).toBe('exp1');
    });
  });

  describe('_test helpers', () => {
    it('should build prompt with experiments', () => {
      const exps: Experiment[] = [
        {
          id: 'exp1',
          model: 'test',
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
            maxTrainSeconds: 120,
          },
          valLoss: 3.5,
          status: 'completed',
        },
      ];

      const prompt = _test.buildPrompt(exps, 3.5, ['cpu']);

      expect(prompt).toContain('experiment results');
      expect(prompt).toContain('exp1');
      expect(prompt).toContain('3.500');  // Changed from 3.5000
      expect(prompt).toContain('Available hardware: cpu');
    });

    it('should parse JSON from markdown code block', async () => {
      const response = '```json{"type":"explore",' +
        '"hyperparams":{"learningRate":0.001},"reasoning":"Test"}```';

      const exps: Experiment[] = [];
      const proposal = await _test.parseMutationResponse(response, exps, 0, ['cpu']);

      expect(proposal.hyperparams.learningRate).toBe(0.001);
      expect(proposal.reasoning).toBe('Test');
    });

    it('should extract JSON from text with extra content', async () => {
      const response = 'Here is the result {"type":"explore",' +
        '"hyperparams":{"learningRate":0.001},"reasoning":"Test"}';

      const exps: Experiment[] = [];
      const proposal = await _test.parseMutationResponse(response, exps, 0, ['cpu']);

      expect(proposal.hyperparams.learningRate).toBe(0.001);
    });

    it('should clamp values exceeding maximum', async () => {
      const response = '{"type":"explore",' +
        '"hyperparams":{' +
        '"learningRate":1.0,' +
        '"batchSize":256,' +
        '"numLayers":20,' +
        '"weightDecay":1.0' +
        '},"reasoning":"Test"}';

      const exps: Experiment[] = [];
      const proposal = await _test.parseMutationResponse(response, exps, 0, ['cpu']);

      expect(proposal.hyperparams.learningRate).toBe(0.01);  // Max
      expect(proposal.hyperparams.batchSize).toBe(128);  // Rounded
      expect(proposal.hyperparams.numLayers).toBe(8);  // Max
      expect(proposal.hyperparams.weightDecay).toBe(0.1);  // Max
    });

    it('should use defaults for missing values', async () => {
      const response = '{"type":"explore",' +
        '"hyperparams":{' +
        '"maxTrainSeconds":180' +
        '},"reasoning":"Test"}';

      const exps: Experiment[] = [];
      const proposal = await _test.parseMutationResponse(response, exps, 0, ['cpu']);

      expect(proposal.hyperparams.learningRate).toBe(0.001);  // Default
      expect(proposal.hyperparams.batchSize).toBe(32);  // Default
      expect(proposal.hyperparams.hiddenDim).toBe(128);  // Default
      expect(proposal.hyperparams.activation).toBe('gelu');  // Default
    });

    it('should throw when no JSON found in response', async () => {
      const response = 'This is just text without any JSON object';

      const exps: Experiment[] = [];
      
      try {
        await _test.parseMutationResponse(response, exps, 0, ['cpu']);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toBe('Failed to parse JSON from LLM response');
      }
    });
  });
});
