/**
 * Provider whitelist + model tiers.
 *
 * Single source of truth for cloud LLM providers and the three tiers
 * (top / mid / budget) that the node operator can pick from. Endpoints
 * are hardcoded — operators do not get to point the node at arbitrary
 * URLs, because the response schema we parse only matches the vendors
 * listed here.
 *
 * Adding a provider means:
 *   1. Add an entry to CLOUD_PROVIDERS.
 *   2. Add the corresponding adapter under ./adapters/ and register it
 *      in ./adapters/index.ts.
 *   3. Add fixtures + spec under ./adapters/__tests__/.
 */

export type CloudProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'moonshot'
  | 'minimax'
  | 'zhipu'
  | 'nvidia';

export type ModelTier = 'top' | 'mid' | 'budget';

export interface ModelDescriptor {
  modelId: string;
  /** Approximate latency in ms for the first byte; used for pre-flight scoring. */
  latencyMs: number;
  /** Vendor-published context window. */
  maxTokens: number;
  /** Approx USD cost per call assuming a small (~500 token) prompt. */
  costPerCall?: number;
}

export interface CloudProviderEntry {
  /** Internal id used in `provider/model` slugs and adapter dispatch. */
  id: CloudProviderId;
  /** Human-readable label shown in the node-ui dropdown. */
  label: string;
  /**
   * Hardcoded chat-completion endpoint. Adapters may rewrite per request
   * (e.g. Google embeds the model id in the URL path).
   */
  endpoint: string;
  /** Env var the node reads when no API key is in config. */
  apiKeyEnvVar: string;
  /** Top / mid / budget model — exactly three entries, in that order. */
  models: Record<ModelTier, ModelDescriptor>;
}

export const CLOUD_PROVIDERS: readonly CloudProviderEntry[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: {
      top: { modelId: 'gpt-5', latencyMs: 600, maxTokens: 400_000, costPerCall: 0.005 },
      mid: { modelId: 'gpt-4o', latencyMs: 400, maxTokens: 128_000, costPerCall: 0.0025 },
      budget: { modelId: 'gpt-4o-mini', latencyMs: 250, maxTokens: 128_000, costPerCall: 0.0006 },
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    models: {
      top: { modelId: 'claude-opus-4-7', latencyMs: 700, maxTokens: 200_000, costPerCall: 0.015 },
      mid: { modelId: 'claude-sonnet-4-6', latencyMs: 300, maxTokens: 200_000, costPerCall: 0.003 },
      budget: { modelId: 'claude-haiku-4-5', latencyMs: 200, maxTokens: 200_000, costPerCall: 0.0008 },
    },
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    endpoint:
      'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    models: {
      top: { modelId: 'gemini-2.5-pro', latencyMs: 600, maxTokens: 1_048_576, costPerCall: 0.0035 },
      mid: { modelId: 'gemini-2.5-flash', latencyMs: 300, maxTokens: 1_048_576, costPerCall: 0.0008 },
      budget: { modelId: 'gemini-2.5-flash-lite', latencyMs: 200, maxTokens: 1_048_576, costPerCall: 0.00015 },
    },
  },
  {
    id: 'moonshot',
    label: 'Kimi (Moonshot)',
    endpoint: 'https://api.moonshot.ai/v1/chat/completions',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    models: {
      top: { modelId: 'kimi-k2.6', latencyMs: 500, maxTokens: 256_000, costPerCall: 0.002 },
      mid: { modelId: 'kimi-k2-0711-preview', latencyMs: 350, maxTokens: 131_072, costPerCall: 0.001 },
      budget: { modelId: 'moonshot-v1-32k', latencyMs: 300, maxTokens: 32_768, costPerCall: 0.0005 },
    },
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    endpoint: 'https://api.minimax.io/v1/chat/completions',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    models: {
      top: { modelId: 'MiniMax-M2.7', latencyMs: 400, maxTokens: 245_760, costPerCall: 0.0015 },
      mid: { modelId: 'abab7-chat-preview', latencyMs: 350, maxTokens: 245_760, costPerCall: 0.0008 },
      budget: { modelId: 'abab6.5s-chat', latencyMs: 300, maxTokens: 245_760, costPerCall: 0.0003 },
    },
  },
  {
    id: 'zhipu',
    label: 'Zhipu (GLM)',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyEnvVar: 'ZHIPU_API_KEY',
    models: {
      top: { modelId: 'glm-4.6', latencyMs: 500, maxTokens: 200_000, costPerCall: 0.0015 },
      mid: { modelId: 'glm-4-plus', latencyMs: 400, maxTokens: 128_000, costPerCall: 0.0008 },
      budget: { modelId: 'glm-4-flash', latencyMs: 250, maxTokens: 128_000, costPerCall: 0.0001 },
    },
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM (free)',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKeyEnvVar: 'NVIDIA_API_KEY',
    // Free tier on build.nvidia.com (~5,000 credits/month for verified
    // developers). Operators run Synapseia without paying a vendor or
    // owning a local GPU. The only cost is registering at
    // build.nvidia.com to obtain a personal `nvapi-...` API key.
    //
    // Top: NVIDIA's flagship Nemotron-3 Super 120B MoE (~12B active),
    // tuned for instruction-following + scientific reasoning, best fit
    // for Synapseia's biomedical KG extraction and peer-review work.
    // Mid:  Meta's Llama 3.3 70B Instruct (production-stable, no
    //       reasoning prefix to strip, strong on PubMedQA/MedMCQA).
    // Budget: Meta's Llama 3.2 3B Instruct (low-latency for tier-0
    //         inference and budget review work orders).
    models: {
      top:    { modelId: 'nvidia/nemotron-3-super-120b-a12b', latencyMs: 500, maxTokens: 128_000, costPerCall: 0 },
      mid:    { modelId: 'meta/llama-3.3-70b-instruct',       latencyMs: 400, maxTokens: 128_000, costPerCall: 0 },
      budget: { modelId: 'meta/llama-3.2-3b-instruct',        latencyMs: 200, maxTokens: 128_000, costPerCall: 0 },
    },
  },
] as const;

/** Indexed view for O(1) lookup by id. */
export const CLOUD_PROVIDERS_BY_ID: ReadonlyMap<CloudProviderId, CloudProviderEntry> =
  new Map(CLOUD_PROVIDERS.map(p => [p.id, p]));

/**
 * Local Ollama models we list as defaults in node-ui. Operators can pull
 * additional models via `ollama pull` and they'll show up at runtime —
 * this list is just the curated quick-pick set.
 */
export const OLLAMA_DEFAULT_MODELS: readonly ModelDescriptor[] = [
  { modelId: 'qwen2.5:0.5b', latencyMs: 300, maxTokens: 4096 },
  { modelId: 'qwen2.5:3b', latencyMs: 800, maxTokens: 8192 },
  { modelId: 'gemma3:4b', latencyMs: 1200, maxTokens: 8192 },
  { modelId: 'llama3.2:3b', latencyMs: 900, maxTokens: 8192 },
] as const;

export interface ResolvedModel {
  /** Cloud provider id, or 'ollama' / 'synapseia' for non-cloud paths. */
  provider: CloudProviderId | 'ollama' | 'synapseia';
  modelId: string;
  /** Where the request goes. Empty for ollama (resolved at runtime). */
  endpoint: string;
  /** Vendor metadata (latency, max tokens, cost). Undefined for ad-hoc ollama models. */
  descriptor?: ModelDescriptor;
}

/**
 * Resolve a `provider/model` slug against the whitelist. Returns null for
 * unknown providers so callers can apply migration policy (see config.ts).
 */
export function resolveSlug(slug: string): ResolvedModel | null {
  const slash = slug.indexOf('/');
  if (slash <= 0) return null;
  const provider = slug.slice(0, slash);
  const modelId = slug.slice(slash + 1);
  if (!modelId) return null;

  if (provider === 'ollama') {
    const descriptor = OLLAMA_DEFAULT_MODELS.find(m => m.modelId === modelId);
    return { provider: 'ollama', modelId, endpoint: '', descriptor };
  }

  if (provider === 'synapseia') {
    return { provider: 'synapseia', modelId, endpoint: '' };
  }

  const entry = CLOUD_PROVIDERS_BY_ID.get(provider as CloudProviderId);
  if (!entry) return null;

  const descriptor = (Object.values(entry.models) as ModelDescriptor[]).find(
    m => m.modelId === modelId,
  );
  if (!descriptor) return null;
  return { provider: entry.id, modelId, endpoint: entry.endpoint, descriptor };
}

/** Default model used when migration cannot map the user's old slug. */
export const FALLBACK_MODEL_SLUG = 'anthropic/claude-sonnet-4-6';

/** Top-tier slug for a provider, used when only the model id is unknown but the provider is whitelisted. */
export function topSlugFor(provider: CloudProviderId): string {
  const entry = CLOUD_PROVIDERS_BY_ID.get(provider);
  if (!entry) return FALLBACK_MODEL_SLUG;
  return `${entry.id}/${entry.models.top.modelId}`;
}
