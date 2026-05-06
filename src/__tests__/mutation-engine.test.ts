import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MutationEngineHelper } from '../modules/model/mutation-engine';
import type { Experiment } from '../types';

// State-bag for the OllamaHelper mock — factory cannot close over
// mutable outer refs, so the prototype reads from this object that
// individual tests mutate before invoking proposeMutation. Default is
// "ollama unreachable" so pre-existing tests behave exactly as before
// the mock was added (production fallback returns the original chain).
const ollamaState: { available: boolean; models: string[] } = {
  available: false,
  models: [],
};

jest.mock('../modules/llm/ollama.js', () => {
  class MockOllamaHelper {
    async checkOllama(): Promise<{ available: boolean; url: string; models: string[]; recommendedModel: string }> {
      return {
        available: ollamaState.available,
        url: 'http://localhost:11434',
        models: ollamaState.models,
        recommendedModel: 'qwen2.5:0.5b',
      };
    }
  }
  return { OllamaHelper: MockOllamaHelper };
});

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

describe('MutationEngineHelper', () => {
  let helper: MutationEngineHelper;

  beforeEach(() => {
    helper = new MutationEngineHelper();
    // Default: ollama unreachable → filterByInstalledModels returns
    // candidates unchanged (pre-mock production behavior under no-ollama).
    ollamaState.available = false;
    ollamaState.models = [];
  });

  describe('proposeMutation — no experiments (no LLM call)', () => {
    it('should return default config when no experiments', async () => {
      const proposal = await helper.proposeMutation([], 0, ['cpu']);
      expect(proposal.type).toBe('explore');
      expect(proposal.baseExperimentId).toBeNull();
      expect(proposal.hyperparams).toBeDefined();
      expect(proposal.hyperparams.learningRate).toBe(0.001);
      expect(proposal.hyperparams.maxTrainSeconds).toBe(60);
      expect(proposal.reasoning).toContain('Cold start');
    });

    it('should return 300s maxTrainSeconds for GPU hardware', async () => {
      const proposal = await helper.proposeMutation([], 0, ['cpu', 'gpu']);
      expect(proposal.hyperparams.maxTrainSeconds).toBe(180);
    });
  });

  describe('proposeMutation — with experiments (LLM-dependent)', () => {
    it('should call LLM and parse response when experiments exist', async () => {
      const exps = [mockExp('exp1', 3.5)];
      // Mock the internal llmProvider.generateLLM
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'improve',
        baseExperimentId: 'exp1',
        hyperparams: {
          learningRate: 0.005,
          batchSize: 64,
          hiddenDim: 256,
          numLayers: 6,
          numHeads: 8,
          activation: 'silu',
          normalization: 'rmsnorm',
          initScheme: 'kaiming',
          warmupSteps: 200,
          weightDecay: 0.02,
          maxTrainSeconds: 120,
        },
        reasoning: 'Trying larger model with lower learning rate',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(proposal.type).toBe('improve');
      expect(proposal.baseExperimentId).toBe('exp1');
      expect(proposal.hyperparams.learningRate).toBe(0.005);
      expect(proposal.hyperparams.batchSize).toBe(64);
      expect(proposal.hyperparams.activation).toBe('silu');
      expect(proposal.hyperparams.normalization).toBe('rmsnorm');
      expect(proposal.hyperparams.initScheme).toBe('kaiming');
    });

    it('should clamp learningRate to max 0.01', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, learningRate: 0.1 },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(proposal.hyperparams.learningRate).toBe(0.01);
    });

    it('should clamp learningRate to min 0.0001', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, learningRate: 0.00001 },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(proposal.hyperparams.learningRate).toBe(0.0001);
    });

    it('should round batchSize to nearest standard value', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, batchSize: 45 },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(proposal.hyperparams.batchSize).toBe(32);
    });

    it('should clamp numLayers to GPU max (8) when GPU available', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, numLayers: 12 },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu', 'gpu']);
      expect(proposal.hyperparams.numLayers).toBe(8);
    });

    it('should clamp numLayers to CPU max (4) when no GPU — keeps Docker nodes trainable', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, numLayers: 12, hiddenDim: 256 },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(proposal.hyperparams.numLayers).toBe(4);
      expect(proposal.hyperparams.hiddenDim).toBe(128);
    });

    it('should throw MutationEngineError when all candidates fail to emit valid JSON', async () => {
      // We must NEVER fabricate hyperparams and report them as an LLM-proposed
      // experiment. When every candidate model fails, the training WO must
      // abort visibly with a clear error.
      const { MutationEngineError } = require('../modules/model/mutation-engine');
      const exps = [mockExp('exp1')];
      // Mock: 2 attempts on primary model, both return invalid JSON
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue('not json at all');
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      await expect(helper.proposeMutation(exps, 3.5, ['cpu'])).rejects.toThrow(MutationEngineError);
      // Primary gets 2 tries (base + strict prompt)
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    });

    it('should retry with stricter prompt before failing', async () => {
      const exps = [mockExp('exp1')];
      const validResponse = JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams },
        reasoning: 'Stricter-prompt retry succeeded',
      });
      // First call: bad JSON. Second call (strict prompt): valid.
      const mockGenerate = jest.fn<() => Promise<string>>()
        .mockResolvedValueOnce('not json')
        .mockResolvedValueOnce(validResponse);
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(proposal.reasoning).toBe('Stricter-prompt retry succeeded');
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    });

    it('should walk fallback models if primary fails all retries', async () => {
      const exps = [mockExp('exp1')];
      const fallbackResponse = JSON.stringify({
        type: 'improve', baseExperimentId: 'exp1',
        hyperparams: { ...baseHyperparams, hiddenDim: 256 },
        reasoning: 'Fallback model recovered',
      });
      // Primary: 2 bad. Fallback: base prompt returns valid.
      const mockGenerate = jest.fn<() => Promise<string>>()
        .mockResolvedValueOnce('bad')
        .mockResolvedValueOnce('bad')
        .mockResolvedValueOnce(fallbackResponse);
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const primary = { provider: 'ollama' as const, providerId: '' as const, modelId: 'qwen2.5:0.5b' };
      const fallback = { provider: 'ollama' as const, providerId: '' as const, modelId: 'qwen2.5:1.5b' };
      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu'], primary, [fallback]);
      expect(proposal.reasoning).toBe('Fallback model recovered');
      expect(proposal.model.modelId).toBe('qwen2.5:1.5b');
      expect(mockGenerate).toHaveBeenCalledTimes(3);
    });

    it('should validate and fallback invalid activation', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, activation: 'invalid_activation' },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(['gelu', 'relu', 'silu']).toContain(proposal.hyperparams.activation);
    });

    it('should validate and fallback invalid normalization', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, normalization: 'invalid_norm' },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(['layernorm', 'rmsnorm']).toContain(proposal.hyperparams.normalization);
    });

    it('should validate and fallback invalid initScheme', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams, initScheme: 'invalid_scheme' },
        reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(['xavier', 'kaiming', 'normal']).toContain(proposal.hyperparams.initScheme);
    });

    it('should use default values for missing hyperparams', async () => {
      const exps = [mockExp('exp1')];
      const mockGenerate = jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify({
        type: 'explore', baseExperimentId: null, hyperparams: {}, reasoning: 'Test',
      }));
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu']);
      expect(proposal.hyperparams.learningRate).toBe(0.001);
      // CPU default is 16 to keep Docker nodes (sharing cores with Ollama)
      // trainable within the timeout. GPU nodes still default to 32.
      expect(proposal.hyperparams.batchSize).toBe(16);
    });
  });

  describe('filterByInstalledModels — order preservation (regression)', () => {
    // Locks the fix where a [cloud-primary, ollama-fallback, ollama-fallback]
    // chain was being rewritten to put installed Ollama models FIRST,
    // demoting the cloud primary to last. The filter must preserve caller
    // order: cloud passes through, only uninstalled Ollama entries are
    // dropped. We assert via the externally observable order in which
    // generateLLM is invoked, since filterByInstalledModels is private.

    const cloud = { provider: 'cloud' as const, providerId: 'openai-compat', modelId: 'minimax/MiniMax-M2.7' };
    const ollamaSmall = { provider: 'ollama' as const, providerId: '' as const, modelId: 'qwen2.5:0.5b' };
    const ollamaBig = { provider: 'ollama' as const, providerId: '' as const, modelId: 'qwen2.5:1.5b' };

    it('keeps cloud primary first when only one ollama fallback is installed', async () => {
      ollamaState.available = true;
      ollamaState.models = ['qwen2.5:0.5b'];

      const exps = [mockExp('exp1')];
      const validResponse = JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams },
        reasoning: 'Cloud primary served the proposal',
      });
      // Cloud responds successfully on the very first attempt — no fallback walk.
      const mockGenerate = jest.fn<(model: { provider: string; modelId: string }) => Promise<string>>()
        .mockResolvedValue(validResponse);
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(
        exps,
        3.5,
        ['cpu'],
        cloud,
        [ollamaSmall, ollamaBig],
      );

      expect(proposal.reasoning).toBe('Cloud primary served the proposal');
      expect(proposal.model.provider).toBe('cloud');
      expect(proposal.model.modelId).toBe('minimax/MiniMax-M2.7');

      // First invocation must be the cloud model — proves it was NOT demoted
      // behind the installed Ollama entry. qwen2.5:1.5b must never be tried
      // because it is not installed and was filtered out.
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      const firstCallModel = mockGenerate.mock.calls[0][0] as { provider: string; modelId: string };
      expect(firstCallModel.provider).toBe('cloud');
      expect(firstCallModel.modelId).toBe('minimax/MiniMax-M2.7');
      const calledModelIds = mockGenerate.mock.calls.map(c => (c[0] as { modelId: string }).modelId);
      expect(calledModelIds).not.toContain('qwen2.5:1.5b');
    });

    it('walks fallback chain in caller order: cloud → installed ollama, skipping uninstalled', async () => {
      ollamaState.available = true;
      ollamaState.models = ['qwen2.5:0.5b'];

      const exps = [mockExp('exp1')];
      const fallbackResponse = JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams },
        reasoning: 'Ollama fallback served after cloud failed',
      });
      // Cloud: 2 bad (base + strict). Ollama qwen2.5:0.5b: base prompt wins.
      const mockGenerate = jest.fn<(model: { provider: string; modelId: string }) => Promise<string>>()
        .mockResolvedValueOnce('not json')
        .mockResolvedValueOnce('still bad')
        .mockResolvedValueOnce(fallbackResponse);
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(
        exps,
        3.5,
        ['cpu'],
        cloud,
        [ollamaSmall, ollamaBig],
      );

      expect(proposal.reasoning).toBe('Ollama fallback served after cloud failed');
      expect(proposal.model.provider).toBe('ollama');
      expect(proposal.model.modelId).toBe('qwen2.5:0.5b');
      // Exactly 3 attempts: cloud×2 then ollamaSmall×1. ollamaBig never tried.
      expect(mockGenerate).toHaveBeenCalledTimes(3);
      const calledIds = mockGenerate.mock.calls.map(c => (c[0] as { modelId: string }).modelId);
      expect(calledIds).toEqual(['minimax/MiniMax-M2.7', 'minimax/MiniMax-M2.7', 'qwen2.5:0.5b']);
      expect(calledIds).not.toContain('qwen2.5:1.5b');
    });

    it('returns chain unchanged when ollama is unavailable (local.length=0 early-return analog: no installed models)', async () => {
      // No ollama installed at all — preflight returns available:true but
      // models:[]. Chain is cloud-only, so cloud must still be tried first
      // and unchanged (covers the path where remote-only candidates pass
      // through without any local-install gating side effects).
      ollamaState.available = true;
      ollamaState.models = [];

      const exps = [mockExp('exp1')];
      const validResponse = JSON.stringify({
        type: 'explore', baseExperimentId: null,
        hyperparams: { ...baseHyperparams },
        reasoning: 'Cloud-only chain unchanged',
      });
      const mockGenerate = jest.fn<(model: { provider: string; modelId: string }) => Promise<string>>()
        .mockResolvedValue(validResponse);
      (helper as any).llmProvider = { generateLLM: mockGenerate };

      const proposal = await helper.proposeMutation(exps, 3.5, ['cpu'], cloud, []);

      expect(proposal.model.provider).toBe('cloud');
      expect(proposal.model.modelId).toBe('minimax/MiniMax-M2.7');
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      const firstCallModel = mockGenerate.mock.calls[0][0] as { provider: string; modelId: string };
      expect(firstCallModel.provider).toBe('cloud');
    });
  });
});
