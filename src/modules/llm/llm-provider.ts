/**
 * LLM Provider Abstraction Layer
 *
 * Routes a `provider/model` slug to one of three execution paths:
 *   - Ollama (local HTTP)
 *   - Synapseia (F3 internal serving via SynapseiaServingClient)
 *   - Cloud (one of six whitelisted vendors via LLMResponseAdapter)
 *
 * The HTTP wire-protocol details for each cloud vendor live in
 * ./adapters/ so this file only handles dispatch, retries and
 * post-processing (reasoning strip + transient classification).
 */

import { Injectable, Optional } from '@nestjs/common';
import { OllamaHelper, type GenerateOptions } from './ollama';
import { stripReasoning } from '../../shared/sanitize-llm-output';
import { SynapseiaServingClient } from './synapseia-serving-client';
import logger from '../../utils/logger';
import {
  CLOUD_PROVIDERS,
  CLOUD_PROVIDERS_BY_ID,
  OLLAMA_DEFAULT_MODELS,
  type CloudProviderId,
  type ModelDescriptor,
} from './providers';
import { getAdapter } from './adapters';
import { type ChatRequest } from './adapters/llm-response-adapter';

export type { CloudProviderId } from './providers';

export type LLMProvider = 'ollama' | 'cloud' | 'synapseia';

export interface LLMModel {
  provider: LLMProvider;
  providerId: CloudProviderId | '';
  modelId: string;
  /**
   * F3 — fully-qualified Synapseia model version served by this node.
   * Populated only when `provider === 'synapseia'`. Format:
   * `synapseia-agent:gen-<G>:v<N>`. The coord reads this off each
   * auction bid to filter by `MIN_REQUIRED_MODEL_VERSION`.
   */
  synapseiaVersion?: string;
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
  /**
   * @deprecated Endpoints are now hardcoded per provider in providers.ts.
   * The field is kept on the type for one release so older config files
   * still parse without an error; the value is ignored at request-build
   * time and a WARN is logged when a non-empty value reaches a cloud path.
   */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Generate `SUPPORTED_MODELS` from the providers whitelist so the
 * single source of truth lives in providers.ts. Anything else (CLI
 * autocompletion, UI dropdowns, model catalog tests) reads from here.
 */
function buildSupportedModels(): Record<string, LLMModel> {
  const out: Record<string, LLMModel> = {};
  // Cloud entries
  for (const entry of CLOUD_PROVIDERS) {
    for (const tier of ['top', 'mid', 'budget'] as const) {
      const desc = entry.models[tier];
      out[`${entry.id}/${desc.modelId}`] = {
        provider: 'cloud',
        providerId: entry.id,
        modelId: desc.modelId,
      };
    }
  }
  // Ollama defaults
  for (const m of OLLAMA_DEFAULT_MODELS) {
    out[`ollama/${m.modelId}`] = {
      provider: 'ollama',
      providerId: '',
      modelId: m.modelId,
    };
  }
  return out;
}

function buildModelMetadata(): Record<string, ModelDescriptor> {
  const out: Record<string, ModelDescriptor> = {};
  for (const entry of CLOUD_PROVIDERS) {
    for (const tier of ['top', 'mid', 'budget'] as const) {
      const d = entry.models[tier];
      out[d.modelId] = d;
    }
  }
  for (const m of OLLAMA_DEFAULT_MODELS) {
    out[m.modelId] = m;
  }
  return out;
}

export const SUPPORTED_MODELS: Record<string, LLMModel> = buildSupportedModels();
export const MODEL_METADATA: Record<string, ModelDescriptor> = buildModelMetadata();

/**
 * Decide whether an LLM error is worth retrying. We retry transient/server-side
 * errors (rate limits, server overload, connection drops) but never retry hard
 * errors (auth, malformed prompt, model not found) which would just burn quota.
 *
 * Covers:
 * - Minimax error 2064: "server cluster under high load" — explicitly transient.
 * - HTTP 429 / 5xx / timeouts / generic "rate limit" / "overloaded".
 * - Ollama: the llama runner (mmap'd model process) dies mid-generation
 *   under memory pressure or during model eviction. Variants observed:
 *   "runner process no longer running", "runner process has terminated",
 *   and "%!w(<nil>)" (Go format-string leak when Ollama wraps a nil error).
 */
export function isTransientLlmError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
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
    msg.includes('runner process') ||
    msg.includes('%!w') ||
    msg.includes('unexpected eof') ||
    msg.includes('try again') ||
    msg.includes('(transient)')
  );
}

const RETRY_SCHEDULE_MS = [1_000, 3_000, 8_000]; // total ~12s of backoff across 3 retries

@Injectable()
export class LlmProviderHelper {
  private readonly ollamaHelper = new OllamaHelper();

  // F3-C7 — optional Synapseia client. When Nest wires it, any model
  // with `provider: 'synapseia'` is dispatched through it; otherwise we
  // fall back to cloud/ollama so the node keeps serving even pre-F3.
  constructor(@Optional() private readonly synapseia?: SynapseiaServingClient) {}

  // ── Public methods ────────────────────────────────────────────────────────

  toErrorMessage(error: unknown): string {
    try {
      return String((error as { message?: unknown })?.message ?? 'Unknown error');
    } catch {
      return 'Unknown error';
    }
  }

  /**
   * Resolve a slug against the whitelist. Returns null for anything we
   * don't recognise so callers (CLI, config validation) can decide
   * whether to migrate or hard-fail.
   */
  parseModel(modelStr: string): LLMModel | null {
    const known = SUPPORTED_MODELS[modelStr];
    if (known) return known;

    const slash = modelStr.indexOf('/');
    if (slash <= 0) return null;
    const provider = modelStr.slice(0, slash);
    const modelId = modelStr.slice(slash + 1);
    if (!modelId) return null;

    if (provider === 'ollama') {
      // Ollama is open-ended: any pulled model id is valid even if it's
      // not in the curated default list. Trust the runtime check.
      return { provider: 'ollama', providerId: '', modelId };
    }

    if (provider === 'synapseia') {
      return { provider: 'synapseia', providerId: '', modelId };
    }

    if (CLOUD_PROVIDERS_BY_ID.has(provider as CloudProviderId)) {
      // Provider whitelisted but model id off-list. Allow the call —
      // vendors release new models faster than we can update the table —
      // but the metadata estimate (latency/cost) won't be available.
      return { provider: 'cloud', providerId: provider as CloudProviderId, modelId };
    }

    return null;
  }

  async checkLLM(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
    if (model.provider === 'ollama') return this.checkOllamaLLM(model);
    if (model.provider === 'cloud') return this.checkCloudLLM(model, config);
    if (model.provider === 'synapseia') return this.checkSynapseiaLLM(model);
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
        } else if (model.provider === 'synapseia') {
          raw = await this.generateSynapseiaLLM(model, prompt, hyperparams);
        } else {
          throw new Error('Unknown provider');
        }
        break;
      } catch (err) {
        lastErr = err;
        const adapterTransient =
          model.provider === 'cloud' && model.providerId
            ? this.adapterIsTransient(model.providerId as CloudProviderId, err)
            : false;
        if (
          attempt >= RETRY_SCHEDULE_MS.length ||
          (!isTransientLlmError(err) && !adapterTransient)
        ) {
          throw err;
        }
        const wait = RETRY_SCHEDULE_MS[attempt];
        logger.warn(
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

      const meta = MODEL_METADATA[model.modelId];
      const modelAvailable = status.models.includes(model.modelId);

      if (!modelAvailable) {
        return {
          available: false, model,
          estimatedLatencyMs: meta?.latencyMs ?? 500,
          error: `Model ${model.modelId} not found. Pull with: ollama pull ${model.modelId}`,
        };
      }

      return {
        available: true, model,
        estimatedLatencyMs: meta?.latencyMs ?? 500,
        maxTokens: meta?.maxTokens,
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
    if (config.baseUrl) {
      logger.warn(
        `[LLM] config.baseUrl is set ('${config.baseUrl}') but is ignored — endpoints are hardcoded per provider`,
      );
    }
    if (!model.providerId || !CLOUD_PROVIDERS_BY_ID.has(model.providerId as CloudProviderId)) {
      return { available: false, model, estimatedLatencyMs: 0, error: `Unknown cloud provider '${model.providerId}'` };
    }
    const meta = MODEL_METADATA[model.modelId];
    try {
      // Ping the model with a 1-token request. We deliberately use the
      // same code path as a real generate() so adapter changes get caught
      // by the availability check, not just at first real call.
      await this.runAdapterRequest(model, 'Hi', config.apiKey, { maxTokens: 1 });
      return {
        available: true, model,
        estimatedLatencyMs: meta?.latencyMs ?? 400,
        estimatedCostPerCall: meta?.costPerCall,
        maxTokens: meta?.maxTokens,
      };
    } catch (error) {
      return { available: false, model, estimatedLatencyMs: 0, error: this.toErrorMessage(error) };
    }
  }

  private async generateCloudLLM(
    model: LLMModel,
    prompt: string,
    config?: LLMConfig,
    hyperparams?: GenerateOptions,
  ): Promise<string> {
    if (!config?.apiKey) throw new Error('API key required for cloud provider');
    if (!model.providerId || !CLOUD_PROVIDERS_BY_ID.has(model.providerId as CloudProviderId)) {
      throw new Error(`Unknown cloud provider '${model.providerId}'`);
    }
    if (config.baseUrl) {
      logger.warn(
        `[LLM] config.baseUrl is set ('${config.baseUrl}') but is ignored — endpoints are hardcoded per provider`,
      );
    }
    return this.runAdapterRequest(model, prompt, config.apiKey, hyperparams);
  }

  private async runAdapterRequest(
    model: LLMModel,
    prompt: string,
    apiKey: string,
    hyperparams?: GenerateOptions,
  ): Promise<string> {
    const adapter = getAdapter(model.providerId as CloudProviderId);
    const chatReq: ChatRequest = {
      model: model.modelId,
      prompt,
      apiKey,
      hyperparams: hyperparams
        ? {
            temperature: hyperparams.temperature,
            maxTokens: hyperparams.maxTokens,
            forceJson: hyperparams.forceJson,
          }
        : undefined,
    };
    const { url, init } = adapter.buildRequest(chatReq);
    const response = await fetch(url, init);
    // Read once; provider error pages are sometimes HTML.
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      throw adapter.parseError(response.status, body, text);
    }
    const normalized = adapter.parseResponse(response.status, body);
    return normalized.text;
  }

  private adapterIsTransient(providerId: CloudProviderId, err: unknown): boolean {
    try {
      const adapter = getAdapter(providerId);
      return Boolean(adapter.isTransientError?.(err));
    } catch {
      return false;
    }
  }

  // ── Private: Synapseia (F3-C7) ────────────────────────────────────────────

  private async checkSynapseiaLLM(model: LLMModel): Promise<LLMStatus> {
    if (!this.synapseia) {
      return { available: false, model, estimatedLatencyMs: 0, error: 'Synapseia client not wired' };
    }
    const ok = await this.synapseia.isAvailable();
    return {
      available: ok,
      model,
      estimatedLatencyMs: 600,
      error: ok ? undefined : 'local serving runtime not reachable',
    };
  }

  private async generateSynapseiaLLM(
    model: LLMModel,
    prompt: string,
    hyperparams?: GenerateOptions,
  ): Promise<string> {
    if (!this.synapseia) {
      throw new Error('Synapseia client not wired — operator must launch llama.cpp + register swap hook');
    }
    const expected = model.synapseiaVersion;
    const active = this.synapseia.getActiveVersion();
    if (expected && active && expected !== active) {
      throw new Error(
        `Synapseia version mismatch: caller asked ${expected}, node is serving ${active}`,
      );
    }
    const result = await this.synapseia.generate({
      messages: [{ role: 'user', content: prompt }],
      temperature: hyperparams?.temperature,
      maxTokens: hyperparams?.maxTokens,
    });
    return result.content;
  }
}
