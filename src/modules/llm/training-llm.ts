/**
 * Training-LLM resolution
 *
 * The mutation engine needs an LLM that can reliably emit structured JSON
 * (~11 fields, with ranges and enums). Small models like `qwen2.5:0.5b` can
 * parse but not produce that format consistently — every training WO aborts
 * with "LLM response missing hyperparams object".
 *
 * This module decides, at node startup and at each heartbeat, whether a
 * capable training LLM is available. That decision gates the `cpu_training`
 * capability: if no capable model is reachable, the node should NOT advertise
 * cpu_training, and the coordinator will stop assigning training WOs.
 *
 * Detection order:
 *   1. Ollama: query /api/tags, pick the largest model whose name matches
 *      the capable-size allowlist (≥1.5B params).
 *   2. Cloud: if LLM_CLOUD_MODEL + LLM_CLOUD_PROVIDER are set in the env.
 *   3. Neither → null.
 */

import axios from 'axios';
import type { LLMModel, CloudProviderId } from './llm-provider';

/**
 * Vendor prefixes recognised by llm-provider.parseModel(). If LLM_CLOUD_MODEL
 * is written as "<vendor>/<name>" we must strip the prefix so the HTTP request
 * sends the bare model name (e.g. MiniMax-M2.7) instead of the prefixed form,
 * which the upstream endpoint rejects as "model not found".
 */
const CLOUD_PREFIXES: Array<{ prefix: string; providerId: CloudProviderId }> = [
  { prefix: 'openai/',    providerId: 'openai' },
  { prefix: 'anthropic/', providerId: 'anthropic' },
  { prefix: 'google/',    providerId: 'google' },
  { prefix: 'moonshot/',  providerId: 'moonshot' },
  { prefix: 'kimi/',      providerId: 'moonshot' },
  { prefix: 'minimax/',   providerId: 'minimax' },
  { prefix: 'zhipu/',     providerId: 'zhipu' },
  // NVIDIA NIM model ids carry a vendor namespace inside the model name
  // itself (e.g. `nvidia/nemotron-3-super-120b-a12b`,
  // `meta/llama-3.3-70b-instruct`). The slug we receive looks like
  // `nvidia/<vendor>/<model>`. After stripping this outer `nvidia/`
  // prefix the upstream NIM endpoint expects the bare `<vendor>/<model>`
  // form, so the strip semantics line up with the other providers above.
  { prefix: 'nvidia/',    providerId: 'nvidia' },
];

/**
 * Mirrors llm-provider.parseModel() so training uses the SAME routing as
 * research. Research proves minimax/anthropic endpoints work when called
 * via their vendor-specific clients (generateMinimax, generateAnthropic…);
 * the prefix is the single source of truth for providerId. LLM_CLOUD_PROVIDER
 * is only consulted when the model string lacks a known vendor prefix —
 * otherwise we'd diverge from the research path that already works.
 */
function buildCloudModel(
  cloudModel: string | undefined,
  cloudProviderEnv: string | undefined,
): LLMModel | null {
  if (!cloudModel) return null;

  for (const { prefix, providerId } of CLOUD_PREFIXES) {
    if (cloudModel.startsWith(prefix)) {
      const bareModel = cloudModel.slice(prefix.length);
      if (!bareModel) return null;
      return { provider: 'cloud', providerId, modelId: bareModel };
    }
  }

  // No recognised prefix. Require the env to tell us the provider.
  if (cloudProviderEnv) {
    return {
      provider: 'cloud',
      providerId: cloudProviderEnv as CloudProviderId,
      modelId: cloudModel,
    };
  }
  return null;
}

/**
 * Allowlist of model-size markers. Ordered from largest to smallest for
 * priority ranking — the resolver picks the first match when several
 * installed models qualify.
 *
 * Expressed as regexes against the full Ollama model name (e.g.
 * "qwen2.5:1.5b", "llama3.2:3b-instruct-q4_0"). Sizes below 1.5B are
 * deliberately excluded because they consistently fail JSON-schema output
 * on the 11-field mutation prompt.
 */
const CAPABLE_SIZE_MARKERS: RegExp[] = [
  /:?(72b|70b)\b/i,
  /:?(34b|32b)\b/i,
  /:?(14b|13b)\b/i,
  /:?(8b|7b)\b/i,
  /:?(4b)\b/i,
  /:?(3b)\b/i,
  /:?(1\.5b)\b/i,
];

/** Known incapable models, explicit denylist for clarity. */
const INCAPABLE_EXACT: string[] = [
  'qwen2.5:0.5b',
  'qwen2:0.5b',
  'tinyllama',
  'tinyllama:latest',
];

export function isCapableTrainingModel(modelId: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  if (INCAPABLE_EXACT.some(bad => lower === bad.toLowerCase())) return false;
  return CAPABLE_SIZE_MARKERS.some(re => re.test(lower));
}

/**
 * Rank a capable model by approximate parameter count encoded in its name.
 * Higher rank = bigger = preferred. Non-capable names return 0.
 */
function rankModel(modelId: string): number {
  const lower = modelId.toLowerCase();
  const sizeTable: Array<{ re: RegExp; rank: number }> = [
    { re: /:?(72b|70b)\b/i, rank: 72 },
    { re: /:?(34b|32b)\b/i, rank: 32 },
    { re: /:?(14b|13b)\b/i, rank: 14 },
    { re: /:?(8b|7b)\b/i,   rank: 8 },
    { re: /:?(4b)\b/i,      rank: 4 },
    { re: /:?(3b)\b/i,      rank: 3 },
    { re: /:?(1\.5b)\b/i,   rank: 1.5 },
  ];
  for (const { re, rank } of sizeTable) if (re.test(lower)) return rank;
  return 0;
}

export interface ResolveOptions {
  ollamaUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Escape hatch for tests — inject installed models instead of hitting Ollama. */
  fetchInstalledModels?: (url: string) => Promise<string[]>;
}

/**
 * Resolve the best training-capable LLM available to this node.
 * Returns null if none is reachable.
 */
export async function resolveTrainingLlmModel(
  opts: ResolveOptions = {},
): Promise<LLMModel | null> {
  const env = opts.env ?? process.env;
  const ollamaUrl = opts.ollamaUrl ?? env.OLLAMA_URL ?? 'http://localhost:11434';

  // 1. Ollama — prefer a capable (≥1.5B) local model if installed
  let ollamaInstalled: string[] = [];
  try {
    ollamaInstalled = opts.fetchInstalledModels
      ? await opts.fetchInstalledModels(ollamaUrl)
      : await defaultFetchInstalledModels(ollamaUrl);
  } catch {
    // Non-fatal — Ollama may be unreachable; treat as empty list.
  }

  // LLM_MODEL override: operator pinned a specific model (e.g. on a
  // RAM-constrained host where the "capable" 1.5B default OOMs). Honour it
  // verbatim if it's actually installed — bypasses the capable/denylist
  // gates because the operator is declaring "this is what this node can
  // run". Silent fall-through if not installed (misconfiguration
  // shouldn't wedge the node).
  const pinned = env.LLM_MODEL?.trim();
  if (pinned && ollamaInstalled.includes(pinned)) {
    return { provider: 'ollama', providerId: '', modelId: pinned };
  }

  // LLM_PROVIDER override: operator explicitly chose a provider. Cloud
  // gets priority if it's declared AND fully configured, regardless of
  // what Ollama has installed. This stops a co-tenant local Ollama with
  // qwen 1.5b from winning on a box the operator wanted on cloud.
  const provider = env.LLM_PROVIDER?.trim().toLowerCase();
  if (provider === 'cloud') {
    const cloud = buildCloudModel(env.LLM_CLOUD_MODEL, env.LLM_CLOUD_PROVIDER);
    if (cloud) return cloud;
    // Cloud requested but incomplete config → fall through to Ollama
    // cascade rather than returning null (degraded > dead).
  }

  const capable = ollamaInstalled.filter(isCapableTrainingModel);
  capable.sort((a, b) => rankModel(b) - rankModel(a));
  if (capable.length > 0) {
    return { provider: 'ollama', providerId: '', modelId: capable[0] };
  }

  // 2. Cloud — require both provider and model envs. Cloud models handle
  // structured JSON reliably, so they rank above a sub-1.5B Ollama model.
  const cloud = buildCloudModel(env.LLM_CLOUD_MODEL, env.LLM_CLOUD_PROVIDER);
  if (cloud) return cloud;

  // 3. Last resort: a small Ollama model. Not "capable" per the ≥1.5B bar,
  // but it sometimes succeeds at emitting the 11-field mutation JSON and
  // keeps nodes with only lightweight models in the pool. The mutation
  // engine aborts the WO cleanly on failure, so the risk is bounded.
  if (ollamaInstalled.length > 0) {
    return { provider: 'ollama', providerId: '', modelId: ollamaInstalled[0] };
  }

  return null;
}

async function defaultFetchInstalledModels(url: string): Promise<string[]> {
  const response = await axios.get(`${url}/api/tags`, { timeout: 3000 });
  const arr = (response.data?.models ?? []) as Array<{ name?: string }>;
  return arr.map(m => m?.name ?? '').filter(Boolean);
}

/**
 * Resolve primary model + ordered fallback chain for training mutation.
 *
 * Cascade rationale: the mutation engine emits a 11-field JSON schema;
 * different LLMs fail in different ways (Ollama 0.5b malforms property
 * names, minimax occasionally appends trailing tokens that break JSON
 * parsing). Providing ALL available options as fallbacks means a single
 * model's bad day doesn't kill the training WO.
 *
 * Order: best capable Ollama > cloud > any remaining Ollama.
 */
export async function resolveTrainingChain(
  opts: ResolveOptions = {},
): Promise<{ primary: LLMModel; fallbacks: LLMModel[] } | null> {
  const env = opts.env ?? process.env;
  const ollamaUrl = opts.ollamaUrl ?? env.OLLAMA_URL ?? 'http://localhost:11434';

  let ollamaInstalled: string[] = [];
  try {
    ollamaInstalled = opts.fetchInstalledModels
      ? await opts.fetchInstalledModels(ollamaUrl)
      : await defaultFetchInstalledModels(ollamaUrl);
  } catch { /* Ollama unreachable */ }

  const capable = ollamaInstalled.filter(isCapableTrainingModel);
  capable.sort((a, b) => rankModel(b) - rankModel(a));
  // TODO: filter chain to chat-capable models only — `others` currently
  // includes embedding models (e.g. all-minilm-l6-v2) which fail with
  // "does not support chat" when the mutation engine prompts them.
  // Track chat vs embedding capability per Ollama model and exclude
  // non-chat models from the fallback chain entirely.
  const others = ollamaInstalled.filter(m => !isCapableTrainingModel(m));

  const cloud = buildCloudModel(env.LLM_CLOUD_MODEL, env.LLM_CLOUD_PROVIDER);

  const asOllama = (modelId: string): LLMModel => ({
    provider: 'ollama', providerId: '', modelId,
  });

  // LLM_MODEL / LLM_PROVIDER overrides: same semantics as
  // resolveTrainingLlmModel. LLM_MODEL wins first (verbatim model pin),
  // then LLM_PROVIDER=cloud promotes the cloud model to primary. Both
  // preserve the full cascade in case the chosen primary fails on a WO.
  const pinned = env.LLM_MODEL?.trim();
  const provider = env.LLM_PROVIDER?.trim().toLowerCase();
  let ranked: LLMModel[];
  if (pinned && ollamaInstalled.includes(pinned)) {
    ranked = [
      asOllama(pinned),
      ...capable.filter(m => m !== pinned).map(asOllama),
      ...(cloud ? [cloud] : []),
      ...others.filter(m => m !== pinned).map(asOllama),
    ];
  } else if (provider === 'cloud' && cloud) {
    ranked = [
      cloud,
      ...capable.map(asOllama),
      ...others.map(asOllama),
    ];
  } else {
    ranked = [
      ...capable.map(asOllama),
      ...(cloud ? [cloud] : []),
      ...others.map(asOllama),
    ];
  }

  if (ranked.length === 0) return null;
  return { primary: ranked[0], fallbacks: ranked.slice(1) };
}
