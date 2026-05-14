/**
 * Coverage for the pure helpers exported from `../providers`.
 *
 * `resolveCloudApiKeyFromEnv` is the env-var fallback the CLI applies
 * when neither `--llm-key` nor the persisted `config.llmKey` carries a
 * cloud key. It mirrors the contract that Tauri's `cloud_llm_env_for`
 * uses when spawning the CLI from the desktop UI (generic
 * `LLM_CLOUD_API_KEY` first, then a provider-specific `<P>_API_KEY`).
 *
 * Each test snapshots and restores any env var it touches so the suite
 * is independent of host env vars set on the developer's machine.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveCloudApiKeyFromEnv, CLOUD_PROVIDERS } from '../providers';

const ENV_KEYS = [
  'LLM_CLOUD_API_KEY',
  ...CLOUD_PROVIDERS.map(p => p.apiKeyEnvVar),
];

describe('resolveCloudApiKeyFromEnv', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('returns LLM_CLOUD_API_KEY when set (generic catch-all has highest priority)', () => {
    process.env.LLM_CLOUD_API_KEY = 'generic-key';
    expect(resolveCloudApiKeyFromEnv('nvidia/meta/llama-3.3-70b-instruct')).toBe(
      'generic-key',
    );
  });

  it('returns NVIDIA_API_KEY for an nvidia slug when generic is unset', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-test';
    expect(resolveCloudApiKeyFromEnv('nvidia/meta/llama-3.3-70b-instruct')).toBe(
      'nvapi-test',
    );
  });

  it('extracts the provider from the first slash even when model id contains another slash', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-multi';
    expect(
      resolveCloudApiKeyFromEnv('nvidia/nvidia/nemotron-3-super-120b-a12b'),
    ).toBe('nvapi-multi');
  });

  it('returns OPENAI_API_KEY for an openai slug', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(resolveCloudApiKeyFromEnv('openai/gpt-4o')).toBe('sk-openai');
  });

  it('returns ANTHROPIC_API_KEY for an anthropic slug', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    expect(resolveCloudApiKeyFromEnv('anthropic/claude-sonnet-4-6')).toBe('sk-ant');
  });

  it('returns undefined for an ollama slug (no apiKeyEnvVar registered)', () => {
    process.env.NVIDIA_API_KEY = 'should-not-leak';
    expect(resolveCloudApiKeyFromEnv('ollama/qwen2.5:0.5b')).toBeUndefined();
  });

  it('returns undefined for empty / undefined / non-string slug input', () => {
    expect(resolveCloudApiKeyFromEnv(undefined)).toBeUndefined();
    expect(resolveCloudApiKeyFromEnv('')).toBeUndefined();
    // The signature is `string | undefined`, but the helper guards
    // against non-string inputs defensively (e.g. a future caller
    // accidentally passing a number). Cast through unknown to verify
    // the runtime guard fires.
    expect(
      resolveCloudApiKeyFromEnv(123 as unknown as string | undefined),
    ).toBeUndefined();
  });

  it('returns undefined for an unknown provider id', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(resolveCloudApiKeyFromEnv('unknown/model')).toBeUndefined();
  });

  it('returns undefined when the provider env var is empty or whitespace-only', () => {
    process.env.NVIDIA_API_KEY = '';
    expect(resolveCloudApiKeyFromEnv('nvidia/meta/llama-3.3-70b-instruct')).toBeUndefined();
    process.env.NVIDIA_API_KEY = '   ';
    expect(resolveCloudApiKeyFromEnv('nvidia/meta/llama-3.3-70b-instruct')).toBeUndefined();
  });

  it('returns undefined when generic LLM_CLOUD_API_KEY is whitespace-only and no provider key set', () => {
    process.env.LLM_CLOUD_API_KEY = '   ';
    expect(resolveCloudApiKeyFromEnv('nvidia/meta/llama-3.3-70b-instruct')).toBeUndefined();
  });

  it('generic LLM_CLOUD_API_KEY beats provider-specific even when both are set', () => {
    process.env.LLM_CLOUD_API_KEY = 'generic-wins';
    process.env.NVIDIA_API_KEY = 'should-not-be-returned';
    expect(resolveCloudApiKeyFromEnv('nvidia/meta/llama-3.3-70b-instruct')).toBe(
      'generic-wins',
    );
  });

  it('returns undefined for a slug missing a slash (no provider boundary)', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(resolveCloudApiKeyFromEnv('justmodelid')).toBeUndefined();
  });

  it('returns undefined when slug starts with a slash (empty provider)', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(resolveCloudApiKeyFromEnv('/gpt-4o')).toBeUndefined();
  });
});
