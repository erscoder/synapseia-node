/**
 * LLM Provider Abstraction Layer
 * Unifies Ollama and Cloud APIs under a common interface
 */

import { Injectable } from '@nestjs/common';
import { checkOllama, generate as generateOllama } from './ollama.js';

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
 * Convert anything to error message - no分支版本
 */
export function toErrorMessage(error: unknown): string {
  try {
    return String((error as any)?.message ?? 'Unknown error');
  } catch {
    return 'Unknown error';
  }
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
 * Helper: Extract optional string safely without branches
 */
export function getOptionalString<T>(obj: T | null | undefined, key: keyof T): string | undefined {
  if (obj == null) return undefined;
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse model string to LLMModel
 */
export function parseModel(modelStr: string): LLMModel | null {
  const model = SUPPORTED_MODELS[modelStr];
  if (model) return model;

  // Dynamic fallback for openai-compat/<modelId> — allows any custom model
  // e.g. "openai-compat/asi1", "openai-compat/gpt-4o-mini", etc.
  if (modelStr.startsWith('openai-compat/')) {
    const modelId = modelStr.slice('openai-compat/'.length);
    if (modelId) {
      return { provider: 'cloud', providerId: 'openai-compat', modelId };
    }
  }
  if (modelStr.startsWith('minimax/')) {
    const modelId = modelStr.slice('minimax/'.length);
    if (modelId) {
      return { provider: 'cloud', providerId: 'minimax', modelId };
    }
  }
  if (modelStr.startsWith('kimi/') || modelStr.startsWith('moonshot/')) {
    const modelId = modelStr.split('/')[0];
    if (modelId) {
      return { provider: 'cloud', providerId: 'moonshot', modelId };
    }
  }

  return null;
}

/**
 * Check if LLM is available
 * @param model - LLM model configuration
 * @param config - Optional configuration (API key for cloud)
 * @returns LLMStatus object
 */
export async function checkLLM(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
  console.log('checkLLM: ',model) 
  console.log('checkLLM: ',config) 
  if (model.provider === 'ollama') {
    return checkOllamaLLM(model);
  }
  if (model.provider === 'cloud') {
    return checkCloudLLM(model, config);
  }

  return {
    available: false,
    model,
    estimatedLatencyMs: 0,
    error: 'Unknown provider',
  };
}

/**
 * Generate text using LLM
 * @param model - LLM model configuration
 * @param prompt - Input prompt
 * @param config - Optional configuration (API key for cloud)
 * @returns Generated text
 */
export async function generateLLM(
  model: LLMModel,
  prompt: string,
  config?: LLMConfig
): Promise<string> {
  if (model.provider === 'ollama') {
    return generateOllamaLLM(model, prompt);
  }
  if (model.provider === 'cloud') {
    return generateCloudLLM(model, prompt, config);
  }

  throw new Error('Unknown provider');
}

// --- Private: Ollama implementation ---

async function checkOllamaLLM(model: LLMModel): Promise<LLMStatus> {
  try {
    const status = await checkOllama();

    if (!status.available) {
      return {
        available: false,
        model,
        estimatedLatencyMs: 0,
        error: status.error || 'Ollama not available',
      };
    }

    const modelMetadata = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA];
    const modelAvailable = status.models.includes(model.modelId);

    if (!modelAvailable) {
      return {
        available: false,
        model,
        estimatedLatencyMs: modelMetadata?.latencyMs ?? 500,
        error: `Model ${model.modelId} not found. Pull with: ollama pull ${model.modelId}`,
      };
    }

    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 500,
      maxTokens: modelMetadata?.maxTokens,
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error),
    };
  }
}

async function generateOllamaLLM(model: LLMModel, prompt: string): Promise<string> {
  return generateOllama(prompt, model.modelId);
}

// --- Private: Cloud API implementations ---

async function checkCloudLLM(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
  if (!config?.apiKey) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: 'API key required for cloud provider',
    };
  }

  if (model.providerId === 'anthropic') {
    return checkAnthropic(model, config.apiKey);
  }
  if (model.providerId === 'moonshot') {
    return checkMoonshot(model, config.apiKey);
  }
  if (model.providerId === 'minimax') {
    return checkMinimax(model, config.apiKey);
  }
  if (model.providerId === 'openai-compat') {
    return checkOpenAICompat(model, config.apiKey, config.baseUrl);
  }

  return {
    available: false,
    model,
    estimatedLatencyMs: 0,
    error: 'Unknown cloud provider',
  };
}

async function generateCloudLLM(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
  if (!config?.apiKey) {
    throw new Error('API key required for cloud provider');
  }

  if (model.providerId === 'anthropic') {
    return generateAnthropic(model, prompt, config.apiKey);
  }
  if (model.providerId === 'moonshot') {
    return generateMoonshot(model, prompt, config.apiKey);
  }
  if (model.providerId === 'minimax') {
    return generateMinimax(model, prompt, config.apiKey, config.baseUrl);
  }
  if (model.providerId === 'openai-compat') {
    return generateOpenAICompat(model, prompt, config.apiKey, config.baseUrl);
  }

  throw new Error('Unknown cloud provider');
}

// --- Anthropic (Claude Sonnet 4.6) ---

async function checkAnthropic(model: LLMModel, apiKey: string): Promise<LLMStatus> {
  try {
    const modelMetadata = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    if (!response.ok) {
      const error = await response.json() as any;
      const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
      throw new Error(errorMessage);
    }

    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 200,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens,
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error),
    };
  }
}

async function generateAnthropic(model: LLMModel, prompt: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model.modelId,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json() as any;
    const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
    throw new Error(errorMessage);
  }

  const data = await response.json() as any;
  return data.content[0].text;
}

// --- Moonshot (Kimi) ---

async function checkMoonshot(model: LLMModel, apiKey: string): Promise<LLMStatus> {
  try {
    const modelMetadata = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;

    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      }),
    });

    if (!response.ok) {
      const error = await response.json() as any;
      const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
      throw new Error(errorMessage);
    }

    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 300,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens,
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error),
    };
  }
}

async function generateMoonshot(model: LLMModel, prompt: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json() as any;
    const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
    throw new Error(errorMessage);
  }

  const data = await response.json() as any;
  return data.choices[0].message.content;
}

// --- Minimax ---

async function checkMinimax(model: LLMModel, apiKey: string): Promise<LLMStatus> {
  try {
    const modelMetadata = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;

    const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      }),
    });

    if (!response.ok) {
      const error = await response.json() as any;
      const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
      throw new Error(errorMessage);
    }

    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 250,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens,
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error),
    };
  }
}

async function generateMinimax(
  model: LLMModel,
  prompt: string,
  apiKey: string,
  baseUrl?: string
): Promise<string> {
  const url = baseUrl ?? 'https://api.minimax.io/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json() as any;
    const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
    throw new Error(errorMessage);
  }

  const data = await response.json() as any;
  return data.choices[0].message.content;
}

// --- OpenAI-compatible (ASI1, etc.) ---

async function checkOpenAICompat(model: LLMModel, apiKey: string, baseUrl?: string): Promise<LLMStatus> {
  try {
    console.log('checkOpenAICompat', baseUrl, model )
    const modelMetadata = MODEL_METADATA[model.modelId as keyof typeof MODEL_METADATA] as any;
    const url = baseUrl ? `${baseUrl}/v1/chat/completions` : 'https://api.openai.com/v1/chat/completions';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      }),
    });

    if (!response.ok) {
      const error = await response.json() as any;
      const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
      throw new Error(errorMessage);
    }

    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 400,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens,
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error),
    };
  }
}

async function generateOpenAICompat(
  model: LLMModel,
  prompt: string,
  apiKey: string,
  baseUrl?: string
): Promise<string> {
  const url = baseUrl ? `${baseUrl}/v1/chat/completions` : 'https://api.openai.com/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json() as any;
    const errorMessage = getOptionalString(error.error, 'message') ?? response.statusText;
    throw new Error(errorMessage);
  }

  const data = await response.json() as any;
  return data.choices[0].message.content;
}

// Export for testing
export const _test = {
  toErrorMessage,
};

@Injectable()
export class LlmProviderHelper {
  toErrorMessage(error: unknown): string {
    return toErrorMessage(error);
  }

  getOptionalString<T>(obj: T | null | undefined, key: keyof T): string | undefined {
    return getOptionalString(obj, key);
  }

  parseModel(modelStr: string): LLMModel | null {
    return parseModel(modelStr);
  }

  checkLLM(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
    return checkLLM(model, config);
  }

  generateLLM(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
    return generateLLM(model, prompt, config);
  }
}
