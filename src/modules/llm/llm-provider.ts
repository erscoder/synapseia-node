/**
 * LLM Provider Abstraction Layer
 * Unifies Ollama and Cloud APIs under a common interface
 */

import { Injectable } from '@nestjs/common';
import { OllamaHelper, type GenerateOptions } from './ollama';
import { stripReasoning } from '../../shared/sanitize-llm-output';

export type LLMProvider = 'ollama' | 'cloud';
export type CloudProviderId = 'anthropic' | 'moonshot' | 'minimax' | 'openai-compat';

export interface LLMModel {
  provider: LLMProvider;
  providerId: CloudProviderId | '';
  modelId: string;
}

export interface LLMStatus {
  available: boolean;
  model: LLMModel;
  estimatedLatencyMs: number;
  estimatedCostPerCall?: number;
  maxTokens?: number;
  error?: string;
}

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Supported LLM models configuration
 */
export const SUPPORTED_MODELS: Record<string, LLMModel> = {
  'ollama/qwen2.5:0.5b': { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
  'ollama/qwen2.5:3b': { provider: 'ollama', providerId: '', modelId: 'qwen2.5:3b' },
  'ollama/gemma3:4b': { provider: 'ollama', providerId: '', modelId: 'gemma3:4b' },
  'ollama/llama3.2:3b': { provider: 'ollama', providerId: '', modelId: 'llama3.2:3b' },
  'anthropic/sonnet-4.6': { provider: 'cloud', providerId: 'anthropic', modelId: 'sonnet-4.6' },
  'kimi/k2.5': { provider: 'cloud', providerId: 'moonshot', modelId: 'kimi-k2.5' },
  'minimax/MiniMax-M2.7': { provider: 'cloud', providerId: 'minimax', modelId: 'MiniMax-M2.7' },
  'openai-compat/asi1': { provider: 'cloud', providerId: 'openai-compat', modelId: 'asi1' },
  'openai-compat/custom': { provider: 'cloud', providerId: 'openai-compat', modelId: 'custom' },
};

/**
 * Model metadata (latency, cost, max tokens)
 */
export const MODEL_METADATA = {
  'qwen2.5:0.5b': { latencyMs: 300, maxTokens: 4096 },
  'qwen2.5:3b': { latencyMs: 800, maxTokens: 8192 },
  'gemma3:4b': { latencyMs: 1200, maxTokens: 8192 },
  'llama3.2:3b': { latencyMs: 900, maxTokens: 8192 },
  'sonnet-4.6': { latencyMs: 200, maxTokens: 200000, costPerCall: 0.003 },
  'kimi-k2.5': { latencyMs: 300, maxTokens: 131072, costPerCall: 0.002 },
  'MiniMax-M2.7': { latencyMs: 250, maxTokens: 131072, costPerCall: 0.0015 },
  'asi1': { latencyMs: 400, maxTokens: 8192, costPerCall: 0.001 },
  'custom': { latencyMs: 500, maxTokens: 4096 },
};

/**
 * Decide whether an LLM error is worth retrying. We retry transient/server-side
 * errors (rate limits, server overload, connection drops) but never retry hard
 * errors (auth, malformed prompt, model not found) which would just burn quota.
 *
 * Covers:
 * - Minimax error 2064: "server cluster under high load" — explicitly transient.
 * - HTTP 429 / 5xx / timeouts / generic "rate limit" / "overloaded".
 * - Ollama: "llama runner process no longer running", "EOF", connection refused.
 */
export function isTransientLlmError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('2064') ||
    msg.includes('high load') ||
    msg.includes('overloaded') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('too many requests') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('timeout') ||
    msg.includes('econn') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('runner process no longer running') ||
    msg.includes('unexpected eof') ||
    msg.includes('try again')
  );
}

const RETRY_SCHEDULE_MS = [1_000, 3_000, 8_000]; // total ~12s of backoff across 3 retries

@Injectable()
export class LlmProviderHelper {
  private readonly ollamaHelper = new OllamaHelper();

  // ── Public methods ────────────────────────────────────────────────────────

  toErrorMessage(error: unknown): string {
    try {
      return String((error as any)?.message ?? 'Unknown error');
    } catch {
      return 'Unknown error';
    }
  }

  getOptionalString<T>(obj: T | null | undefined, key: keyof T): string | undefined {
    if (obj == null) return undefined;
    const value = obj[key];
    return typeof value === 'string' ? value : undefined;
  }

  parseModel(modelStr: string): LLMModel | null {
    const model = SUPPORTED_MODELS[modelStr];
    if (model) return model;

    if (modelStr.startsWith('openai-compat/')) {
      const modelId = modelStr.slice('openai-compat/'.length);
      if (modelId) return { provider: 'cloud', providerId: 'openai-compat', modelId };
    }
    if (modelStr.startsWith('minimax/')) {
      const modelId = modelStr.slice('minimax/'.length);
      if (modelId) return { provider: 'cloud', providerId: 'minimax', modelId };
    }
    if (modelStr.startsWith('kimi/') || modelStr.startsWith('moonshot/')) {
      const modelId = modelStr.split('/')[1];
      if (modelId) return { provider: 'cloud', providerId: 'moonshot', modelId };
    }

    return null;
  }

  async checkLLM(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
    if (model.provider === 'ollama') return this.checkOllamaLLM(model);
    if (model.provider === 'cloud') return this.checkCloudLLM(model, config);
    return { available: false, model, estimatedLatencyMs: 0, error: 'Unknown provider' };
  }

  async generateLLM(
    model: LLMModel,
    prompt: string,
    config?: LLMConfig,
    hyperparams?: GenerateOptions,
  ): Promise<string> {
    let raw: string | undefined;
    let lastErr: unknown;

    // Retry transient errors (Minimax 2064, HTTP 429/5xx, Ollama runner crashes).
    // Non-transient errors (auth, bad prompt, model missing) bubble up immediately
    // so we don't waste retries on errors that won't go away.
    for (let attempt = 0; attempt <= RETRY_SCHEDULE_MS.length; attempt++) {
      try {
        if (model.provider === 'ollama') {
          raw = await this.generateOllamaLLM(model, prompt, hyperparams);
        } else if (model.provider === 'cloud') {
          raw = await this.generateCloudLLM(model, prompt, config, hyperparams);
        } else {
          throw new Error('Unknown provider');
        }
        break;
      } catch (err) {
        lastErr = err;
        if (attempt >= RETRY_SCHEDULE_MS.length || !isTransientLlmError(err)) {
          throw err;
        }
        const wait = RETRY_SCHEDULE_MS[attempt];
        // eslint-disable-next-line no-console
        console.warn(
          `[LLM] transient error on attempt ${attempt + 1}/${RETRY_SCHEDULE_MS.length + 1} ` +
            `(${this.toErrorMessage(err)}) — retrying in ${wait}ms`,
        );
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }

    if (raw === undefined) throw lastErr ?? new Error('LLM generation failed');

    // Centralized scrub of reasoning-model scratchpad (<think>, <thinking>,
    // channel markers, truncated unclosed variants). Keeps contamination out
    // of submissions, mutation proposals, insights, and corpus entries —
    // callers don't need to strip locally.
    return stripReasoning(raw);
  }

  checkOllama() {
    return this.ollamaHelper.checkOllama();
  }

  generateOllama(prompt: string, modelId: string): Promise<string> {
    return this.ollamaHelper.generate(prompt, modelId);
  }

  get supportedModels() {
    return SUPPORTED_MODELS;
  }

  get modelMetadata() {
    return MODEL_METADATA;
  }

  // ── Private: Ollama ───────────────────────────────────────────────────────

  private async checkOllamaLLM(model: LLMModel): Promise<LLMStatus> {
    try {
      const status = await this.ollamaHelper.checkOllama();
      if (!status.available) {
        return { available: false, model, estimatedLatencyMs: 0, error: status.error || 'Ollama not available' };
      }

      const modelMetadata = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA];
      const modelAvailable = status.models.includes(model.modelId);

      if (!modelAvailable) {
        return {
          available: false, model,
          estimatedLatencyMs: modelMetadata?.latencyMs ?? 500,
          error: `Model ${model.modelId} not found. Pull with: ollama pull ${model.modelId}`,
        };
      }

      return {
        available: true, model,
        estimatedLatencyMs: modelMetadata?.latencyMs ?? 500,
        maxTokens: modelMetadata?.maxTokens,
      };
    } catch (error) {
      return { available: false, model, estimatedLatencyMs: 0, error: this.toErrorMessage(error) };
    }
  }

  private async generateOllamaLLM(model: LLMModel, prompt: string, hyperparams?: GenerateOptions): Promise<string> {
    return this.ollamaHelper.generate(prompt, model.modelId, undefined, hyperparams);
  }

  // ── Private: Cloud routing ────────────────────────────────────────────────

  private async checkCloudLLM(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
    if (!config?.apiKey) {
      return { available: false, model, estimatedLatencyMs: 0, error: 'API key required for cloud provider' };
    }

    switch (model.providerId) {
      case 'anthropic': return this.checkAnthropic(model, config.apiKey);
      case 'moonshot': return this.checkMoonshot(model, config.apiKey);
      case 'minimax': return this.checkMinimax(model, config.apiKey);
      case 'openai-compat': return this.checkOpenAICompat(model, config.apiKey, config.baseUrl);
      default: return { available: false, model, estimatedLatencyMs: 0, error: 'Unknown cloud provider' };
    }
  }

  private async generateCloudLLM(
    model: LLMModel, prompt: string, config?: LLMConfig, hyperparams?: GenerateOptions,
  ): Promise<string> {
    if (!config?.apiKey) throw new Error('API key required for cloud provider');

    switch (model.providerId) {
      case 'anthropic': return this.generateAnthropic(model, prompt, config.apiKey, hyperparams);
      case 'moonshot': return this.generateMoonshot(model, prompt, config.apiKey, hyperparams);
      case 'minimax': return this.generateMinimax(model, prompt, config.apiKey, config.baseUrl, hyperparams);
      case 'openai-compat': return this.generateOpenAICompat(model, prompt, config.apiKey, config.baseUrl, hyperparams);
      default: throw new Error('Unknown cloud provider');
    }
  }

  // ── Private: Anthropic ────────────────────────────────────────────────────

  private async checkAnthropic(model: LLMModel, apiKey: string): Promise<LLMStatus> {
    try {
      const meta = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: model.modelId, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }),
      });
      if (!response.ok) {
        const error = await response.json() as any;
        throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
      }
      return { available: true, model, estimatedLatencyMs: meta?.latencyMs ?? 200, estimatedCostPerCall: meta?.costPerCall, maxTokens: meta?.maxTokens };
    } catch (error) {
      return { available: false, model, estimatedLatencyMs: 0, error: this.toErrorMessage(error) };
    }
  }

  private async generateAnthropic(model: LLMModel, prompt: string, apiKey: string, hyperparams?: GenerateOptions): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model.modelId, max_tokens: hyperparams?.maxTokens ?? 4096,
        ...(hyperparams?.temperature !== undefined && { temperature: hyperparams.temperature }),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
    }
    const data = await response.json() as any;
    return data.content[0].text;
  }

  // ── Private: Moonshot (Kimi) ──────────────────────────────────────────────

  private async checkMoonshot(model: LLMModel, apiKey: string): Promise<LLMStatus> {
    try {
      const meta = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;
      const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model.modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      });
      if (!response.ok) {
        const error = await response.json() as any;
        throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
      }
      return { available: true, model, estimatedLatencyMs: meta?.latencyMs ?? 300, estimatedCostPerCall: meta?.costPerCall, maxTokens: meta?.maxTokens };
    } catch (error) {
      return { available: false, model, estimatedLatencyMs: 0, error: this.toErrorMessage(error) };
    }
  }

  private async generateMoonshot(model: LLMModel, prompt: string, apiKey: string, hyperparams?: GenerateOptions): Promise<string> {
    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.modelId, messages: [{ role: 'user', content: prompt }],
        ...(hyperparams?.temperature !== undefined && { temperature: hyperparams.temperature }),
        ...(hyperparams?.maxTokens !== undefined && { max_tokens: hyperparams.maxTokens }),
      }),
    });
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
    }
    const data = await response.json() as any;
    return data.choices[0].message.content;
  }

  // ── Private: Minimax ──────────────────────────────────────────────────────

  private async checkMinimax(model: LLMModel, apiKey: string): Promise<LLMStatus> {
    try {
      const meta = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;
      const response = await fetch('https://api.minimax.io/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model.modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      });
      if (!response.ok) {
        const error = await response.json() as any;
        throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
      }
      return { available: true, model, estimatedLatencyMs: meta?.latencyMs ?? 250, estimatedCostPerCall: meta?.costPerCall, maxTokens: meta?.maxTokens };
    } catch (error) {
      return { available: false, model, estimatedLatencyMs: 0, error: this.toErrorMessage(error) };
    }
  }

  private async generateMinimax(
    model: LLMModel, prompt: string, apiKey: string, baseUrl?: string, hyperparams?: GenerateOptions,
  ): Promise<string> {
    const url = baseUrl ?? 'https://api.minimax.io/v1/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.modelId, messages: [{ role: 'user', content: prompt }],
        ...(hyperparams?.temperature !== undefined && { temperature: hyperparams.temperature }),
        ...(hyperparams?.maxTokens !== undefined && { max_tokens: hyperparams.maxTokens }),
      }),
    });
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
    }
    const data = await response.json() as any;
    return data.choices[0].message.content;
  }

  // ── Private: OpenAI-compatible ─────────────────────────────────────────────

  private async checkOpenAICompat(model: LLMModel, apiKey: string, baseUrl?: string): Promise<LLMStatus> {
    try {
      const meta = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;
      const url = baseUrl ? `${baseUrl}/v1/chat/completions` : 'https://api.openai.com/v1/chat/completions';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model.modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      });
      if (!response.ok) {
        const error = await response.json() as any;
        throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
      }
      return { available: true, model, estimatedLatencyMs: meta?.latencyMs ?? 400, estimatedCostPerCall: meta?.costPerCall, maxTokens: meta?.maxTokens };
    } catch (error) {
      return { available: false, model, estimatedLatencyMs: 0, error: this.toErrorMessage(error) };
    }
  }

  private async generateOpenAICompat(
    model: LLMModel, prompt: string, apiKey: string, baseUrl?: string, hyperparams?: GenerateOptions,
  ): Promise<string> {
    const url = baseUrl ? `${baseUrl}/v1/chat/completions` : 'https://api.openai.com/v1/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.modelId, messages: [{ role: 'user', content: prompt }],
        ...(hyperparams?.temperature !== undefined && { temperature: hyperparams.temperature }),
        ...(hyperparams?.maxTokens !== undefined && { max_tokens: hyperparams.maxTokens }),
        // response_format enforces valid JSON on OpenAI-compat endpoints
        ...(hyperparams?.forceJson && { response_format: { type: 'json_object' } }),
      }),
    });
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(this.getOptionalString(error.error, 'message') ?? response.statusText);
    }
    const data = await response.json() as any;
    return data.choices[0].message.content;
  }
}