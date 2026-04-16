import { describe, it, expect } from '@jest/globals';
import {
  isCapableTrainingModel,
  resolveTrainingLlmModel,
  resolveTrainingChain,
} from '../modules/llm/training-llm';

describe('isCapableTrainingModel', () => {
  it('rejects sub-1.5B models', () => {
    expect(isCapableTrainingModel('qwen2.5:0.5b')).toBe(false);
    expect(isCapableTrainingModel('qwen2:0.5b')).toBe(false);
    expect(isCapableTrainingModel('tinyllama')).toBe(false);
  });

  it('accepts 1.5B and above', () => {
    expect(isCapableTrainingModel('qwen2.5:1.5b')).toBe(true);
    expect(isCapableTrainingModel('qwen2.5:3b')).toBe(true);
    expect(isCapableTrainingModel('llama3.2:3b')).toBe(true);
    expect(isCapableTrainingModel('llama3:8b')).toBe(true);
    expect(isCapableTrainingModel('mistral:7b')).toBe(true);
    expect(isCapableTrainingModel('qwen2.5:72b')).toBe(true);
  });

  it('handles quantisation suffixes', () => {
    expect(isCapableTrainingModel('llama3.2:3b-instruct-q4_0')).toBe(true);
    expect(isCapableTrainingModel('qwen2.5:7b-instruct-q8')).toBe(true);
  });

  it('returns false for empty / unknown', () => {
    expect(isCapableTrainingModel('')).toBe(false);
    expect(isCapableTrainingModel('unknown-model')).toBe(false);
  });
});

describe('resolveTrainingLlmModel', () => {
  it('returns Ollama candidate when capable model is installed', async () => {
    const result = await resolveTrainingLlmModel({
      env: {},
      fetchInstalledModels: async () => ['qwen2.5:0.5b', 'qwen2.5:1.5b', 'llama3.2:3b'],
    });
    expect(result).not.toBeNull();
    expect(result?.provider).toBe('ollama');
    // Should pick the larger one (llama3.2:3b over qwen2.5:1.5b)
    expect(result?.modelId).toBe('llama3.2:3b');
  });

  it('prefers the largest available capable model', async () => {
    const result = await resolveTrainingLlmModel({
      env: {},
      fetchInstalledModels: async () => ['qwen2.5:1.5b', 'qwen2.5:7b', 'qwen2.5:3b'],
    });
    expect(result?.modelId).toBe('qwen2.5:7b');
  });

  it('falls back to cloud when no Ollama model is capable', async () => {
    const result = await resolveTrainingLlmModel({
      env: { LLM_CLOUD_MODEL: 'minimax/MiniMax-M2.7', LLM_CLOUD_PROVIDER: 'minimax' },
      fetchInstalledModels: async () => ['qwen2.5:0.5b'],
    });
    // Vendor prefix stripped — generateCloudLLM expects the bare model name.
    expect(result).toEqual({
      provider: 'cloud',
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
    });
  });

  it('uses the prefix-inferred provider, not LLM_CLOUD_PROVIDER — matches research parseModel path', async () => {
    // Parity with llm-provider.parseModel: prefix wins. Research already
    // works with prefix-inferred routing (`minimax/...` → generateMinimax),
    // so training must do the same to avoid silently diverging.
    const result = await resolveTrainingLlmModel({
      env: { LLM_CLOUD_MODEL: 'minimax/MiniMax-M2.7', LLM_CLOUD_PROVIDER: 'openai-compat' },
      fetchInstalledModels: async () => [],
    });
    expect(result).toEqual({
      provider: 'cloud',
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
    });
  });

  it('uses LLM_CLOUD_PROVIDER only when the model has no known prefix', async () => {
    const result = await resolveTrainingLlmModel({
      env: { LLM_CLOUD_MODEL: 'some-custom-model', LLM_CLOUD_PROVIDER: 'openai-compat' },
      fetchInstalledModels: async () => [],
    });
    expect(result).toEqual({
      provider: 'cloud',
      providerId: 'openai-compat',
      modelId: 'some-custom-model',
    });
  });

  it('falls back to cloud when Ollama is unreachable', async () => {
    const result = await resolveTrainingLlmModel({
      env: { LLM_CLOUD_MODEL: 'MiniMax-M2.7', LLM_CLOUD_PROVIDER: 'minimax' },
      fetchInstalledModels: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(result?.provider).toBe('cloud');
  });

  it('falls back to small Ollama model when neither capable local nor cloud available', async () => {
    // Sub-1.5B sometimes succeeds at mutation JSON; don't disable the node.
    const result = await resolveTrainingLlmModel({
      env: {},
      fetchInstalledModels: async () => ['qwen2.5:0.5b'],
    });
    expect(result).toEqual({ provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' });
  });

  it('prefers cloud over sub-1.5B local', async () => {
    const result = await resolveTrainingLlmModel({
      env: { LLM_CLOUD_MODEL: 'MiniMax-M2.7', LLM_CLOUD_PROVIDER: 'minimax' },
      fetchInstalledModels: async () => ['qwen2.5:0.5b'],
    });
    expect(result?.provider).toBe('cloud');
  });

  it('returns null only when Ollama empty AND cloud unset', async () => {
    const result = await resolveTrainingLlmModel({
      env: {},
      fetchInstalledModels: async () => [],
    });
    expect(result).toBeNull();
  });

  it('returns null when cloud env is partially set and no Ollama models', async () => {
    const result = await resolveTrainingLlmModel({
      env: { LLM_CLOUD_MODEL: 'foo' }, // missing LLM_CLOUD_PROVIDER
      fetchInstalledModels: async () => [],
    });
    expect(result).toBeNull();
  });
});

describe('resolveTrainingChain', () => {
  it('returns primary + full fallback chain with all alternatives', async () => {
    const chain = await resolveTrainingChain({
      env: { LLM_CLOUD_MODEL: 'minimax/MiniMax-M2.7', LLM_CLOUD_PROVIDER: 'minimax' },
      fetchInstalledModels: async () => ['qwen2.5:0.5b', 'qwen2.5:1.5b'],
    });
    expect(chain).not.toBeNull();
    expect(chain?.primary.modelId).toBe('qwen2.5:1.5b');
    // Cloud + small Ollama as fallbacks
    expect(chain?.fallbacks).toHaveLength(2);
    expect(chain?.fallbacks[0].provider).toBe('cloud');
    expect(chain?.fallbacks[1].modelId).toBe('qwen2.5:0.5b');
  });

  it('falls back to any Ollama when primary is cloud and JSON bug hits', async () => {
    // Regression guard: before this cascade, a cloud-primary with malformed
    // JSON response would abort training. Now a small Ollama acts as fallback.
    const chain = await resolveTrainingChain({
      env: { LLM_CLOUD_MODEL: 'minimax/MiniMax-M2.7', LLM_CLOUD_PROVIDER: 'minimax' },
      fetchInstalledModels: async () => ['qwen2.5:0.5b'],
    });
    expect(chain?.primary.provider).toBe('cloud');
    expect(chain?.fallbacks).toEqual([
      { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
    ]);
  });

  it('returns null when no LLM reachable at all', async () => {
    const chain = await resolveTrainingChain({
      env: {},
      fetchInstalledModels: async () => [],
    });
    expect(chain).toBeNull();
  });
});
