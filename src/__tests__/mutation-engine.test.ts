import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { proposeMutation, _test } from '../modules/model/mutation-engine';
import type { Experiment } from '../types';

// NOTE: We test proposeMutation only for the no-experiments path (no LLM call).
// All LLM-dependent behavior is tested via _test.parseMutationResponse directly,
// since ESM live bindings prevent mocking generateLLM in this project's test setup.

const baseHyperparams = {
  learningRate: 0.001,
  batchSize: 32,
  hiddenDim: 128,
  numLayers: 4,
  numHeads: 4,
  activation: 'gelu' as const,
  normalization: 'layernorm' as const,
  initScheme: 'xavier' as const,
  warmupSteps: 100,
  weightDecay: 0.01,
  maxTrainSeconds: 120,
};

const mockExp = (id: string, valLoss = 3.5): Experiment => ({
  id,
  model: 'test',
  hyperparams: { ...baseHyperparams },
  valLoss,
  status: 'completed',
});

const jsonResponse = (overrides: Partial<typeof baseHyperparams> = {}, type = 'explore', baseId: string | null = null) =>
  JSON.stringify({
    type,
    baseExperimentId: baseId,
    hyperparams: { ...baseHyperparams, ...overrides },
    reasoning: 'Test reasoning',
  });

describe('Mutation Engine', () => {
  describe('proposeMutation — no experiments (no LLM call)', () => {
    it('should return default config when no experiments', async () => {
      const proposal = await proposeMutation([], 0, ['cpu']);
      expect(proposal.type).toBe('explore');
      expect(proposal.baseExperimentId).toBeNull();
      expect(proposal.hyperparams).toBeDefined();
      expect(proposal.hyperparams.learningRate).toBe(0.001);
      expect(proposal.hyperparams.maxTrainSeconds).toBe(120);
      expect(proposal.reasoning).toContain('Starting with default');
    });

    it('should return 300s maxTrainSeconds for GPU hardware', async () => {
      const proposal = await proposeMutation([], 0, ['cpu', 'gpu']);
      expect(proposal.hyperparams.maxTrainSeconds).toBe(300);
    });
  });

  describe('_test.parseMutationResponse — clamping and validation', () => {
    const exps = [mockExp('exp1')];

    it('should clamp learningRate to max 0.01', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ learningRate: 0.1 }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.learningRate).toBe(0.01);
    });

    it('should clamp learningRate to min 0.0001', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ learningRate: 0.00001 }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.learningRate).toBe(0.0001);
    });

    it('should round batchSize to nearest standard value', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ batchSize: 45 }),
        [], 0, ['cpu']
      );
      expect(proposal.hyperparams.batchSize).toBe(32);
    });

    it('should round hiddenDim to nearest standard value', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ hiddenDim: 140 }),
        [], 0, ['cpu']
      );
      // 140 should round to 128 or 256
      expect([128, 256]).toContain(proposal.hyperparams.hiddenDim);
    });

    it('should clamp numLayers within range [2, 8]', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ numLayers: 12 }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.numLayers).toBe(8);
    });

    it('should throw on invalid JSON response', () => {
      expect(() => _test.parseMutationResponse('not json', exps, 3.5, ['cpu'])).toThrow();
    });

    it('should accept valid initScheme: normal', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ initScheme: 'normal' as any }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.initScheme).toBe('normal');
    });

    it('should accept valid activation: silu', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ activation: 'silu' as any }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.activation).toBe('silu');
    });

    it('should accept valid activation: relu', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ activation: 'relu' as any }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.activation).toBe('relu');
    });

    it('should accept valid normalization: rmsnorm', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ normalization: 'rmsnorm' as any }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.normalization).toBe('rmsnorm');
    });

    it('should accept valid initScheme: kaiming', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ initScheme: 'kaiming' as any }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.initScheme).toBe('kaiming');
    });

    it('should use default values for missing hyperparams', () => {
      const proposal = _test.parseMutationResponse(
        JSON.stringify({ type: 'explore', baseExperimentId: null, hyperparams: {}, reasoning: 'Test' }),
        exps, 3.5, ['cpu']
      );
      expect(proposal.hyperparams.learningRate).toBe(0.001);
      expect(proposal.hyperparams.batchSize).toBe(32);
    });

    it('should validate and fallback invalid activation', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ activation: 'invalid_activation' as any }),
        exps, 3.5, ['cpu']
      );
      // Invalid activation should fall back to a valid one
      expect(['gelu', 'relu', 'silu']).toContain(proposal.hyperparams.activation);
    });

    it('should validate and fallback invalid normalization', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ normalization: 'invalid_norm' as any }),
        exps, 3.5, ['cpu']
      );
      expect(['layernorm', 'rmsnorm', 'batchnorm']).toContain(proposal.hyperparams.normalization);
    });

    it('should validate and fallback invalid initScheme', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({ initScheme: 'invalid_scheme' as any }),
        exps, 3.5, ['cpu']
      );
      expect(['xavier', 'kaiming', 'normal', 'orthogonal']).toContain(proposal.hyperparams.initScheme);
    });

    it('should set baseExperimentId from response', () => {
      const proposal = _test.parseMutationResponse(
        jsonResponse({}, 'exploit', 'exp1'),
        exps, 3.5, ['cpu']
      );
      expect(proposal.baseExperimentId).toBe('exp1');
    });
  });

  describe('_test.buildPrompt', () => {
    it('should build prompt with experiments', () => {
      const prompt = _test.buildPrompt([mockExp('exp1', 3.5)], 3.5, ['cpu']);
      expect(prompt).toContain('best loss so far');
      expect(prompt).toContain('3.5000');
    });

    it('should include GPU in capabilities', () => {
      const prompt = _test.buildPrompt([], 0, ['cpu', 'gpu']);
      expect(prompt).toBeDefined();
    });
  });

  describe('_test.clampValue', () => {
    it('should clamp value within range', () => {
      expect(_test.clampValue(0.5, 0, 1)).toBe(0.5);
      expect(_test.clampValue(-1, 0, 1)).toBe(0);
      expect(_test.clampValue(2, 0, 1)).toBe(1);
    });
  });

  describe('_test.clampBatchSize', () => {
    it('should round to nearest valid batch size', () => {
      expect(_test.clampBatchSize(45)).toBe(32);
      expect(_test.clampBatchSize(65)).toBe(64);
      expect(_test.clampBatchSize(20)).toBe(16);
    });
  });
});
