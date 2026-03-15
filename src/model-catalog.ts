/**
 * Model catalog for SynapseIA Network
 * Manages LLM models, compatibility, and pulling from Ollama
 */

import { execSync } from 'child_process';

/**
 * Model categories
 */
export type ModelCategory = 'embedding' | 'general' | 'code' | 'multilingual';

/**
 * Model information
 */
export interface ModelInfo {
  name: string;
  minVram: number; // GB
  recommendedTier: number;
  category: ModelCategory;
  description?: string;
  isCloud?: boolean; // Cloud-only models (0 VRAM)
}

/**
 * Ollama model response
 */
interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

/**
 * Full model catalog (28 models as per specification)
 */
export const MODEL_CATALOG: ModelInfo[] = [
  // Embedding models
  {
    name: 'all-minilm-l6-v2',
    minVram: 0.1,
    recommendedTier: 0,
    category: 'embedding',
    description: 'Lightweight embedding model for vector search',
  },

  // General models (small)
  {
    name: 'qwen2.5-0.5b',
    minVram: 1,
    recommendedTier: 1,
    category: 'general',
    description: 'Tiny general-purpose model',
  },
  {
    name: 'gemma-3-1b-web',
    minVram: 2,
    recommendedTier: 1,
    category: 'general',
    description: 'Small web-optimized general model',
  },
  {
    name: 'phi-2',
    minVram: 2,
    recommendedTier: 1,
    category: 'general',
    description: 'Microsoft Phi-2 small model',
  },
  {
    name: 'tiny-vicuna-1b',
    minVram: 1,
    recommendedTier: 1,
    category: 'general',
    description: 'Tiny general-purpose model',
  },
  {
    name: 'home-3b-v3',
    minVram: 2,
    recommendedTier: 1,
    category: 'general',
    description: 'Home-3B v3 small model',
  },
  {
    name: 'qwen2-0.5b',
    minVram: 1,
    recommendedTier: 1,
    category: 'general',
    description: 'Qwen2 0.5B tiny model',
  },
  {
    name: 'qwen2-0.5b-instruct',
    minVram: 1,
    recommendedTier: 1,
    category: 'general',
    description: 'Qwen2 0.5B instruct-tuned',
  },

  // Code models (small)
  {
    name: 'qwen2.5-coder-0.5b',
    minVram: 1,
    recommendedTier: 1,
    category: 'code',
    description: 'Tiny code model',
  },
  {
    name: 'qwen2.5-coder-1.5b',
    minVram: 2,
    recommendedTier: 1,
   category: 'code',
    description: 'Small code model',
  },

  // General models (medium)
  {
    name: 'qwen2.5-coder-3b',
    minVram: 3,
    recommendedTier: 2,
    category: 'code',
    description: 'Medium code model',
  },
  {
    name: 'gemma-3-1b',
    minVram: 2,
    recommendedTier: 1,
    category: 'general',
    description: 'Google Gemma 3 1B',
  },
  {
    name: 'gemma-3-4b',
    minVram: 4,
    recommendedTier: 2,
    category: 'general',
    description: 'Google Gemma 3 4B',
  },

  // Code models (medium-large)
  {
    name: 'qwen2.5-coder-7b',
    minVram: 6,
    recommendedTier: 2,
    category: 'code',
    description: '7B code model',
  },
  {
    name: 'glm-4-9b',
    minVram: 8,
    recommendedTier: 2,
    category: 'general',
    description: 'GLM-4 9B general model',
  },
  {
    name: 'mistral-7b-instruct',
    minVram: 6,
    recommendedTier: 2,
    category: 'general',
    description: 'Mistral 7B instruct model',
  },

  // General models (large)
  {
    name: 'gemma-3-12b',
    minVram: 10,
    recommendedTier: 3,
    category: 'general',
    description: 'Google Gemma 3 12B',
  },
  {
    name: 'llama-3.1-8b-instruct',
    minVram: 10,
    recommendedTier: 3,
    category: 'general',
    description: 'Meta Llama 3.1 8B instruct',
  },
  {
    name: 'llama-3.2-1b-instruct',
    minVram: 1,
    recommendedTier: 1,
    category: 'general',
    description: 'Meta Llama 3.2 1B instruct',
  },

  // Code models (large)
  {
    name: 'qwen2.5-coder-14b',
    minVram: 12,
    recommendedTier: 3,
    category: 'code',
    description: '14B code model',
  },

  // General models (very large)
  {
    name: 'gpt-oss-20b',
    minVram: 16,
    recommendedTier: 4,
    category: 'general',
    description: '20B general model',
  },
  {
    name: 'gemma-3-27b',
    minVram: 20,
    recommendedTier: 4,
    category: 'general',
    description: 'Google Gemma 3 27B',
  },

  // Code models (very large)
  {
    name: 'qwen2.5-coder-32b',
    minVram: 24,
    recommendedTier: 4,
    category: 'code',
    description: '32B code model (recommended)',
  },

  // General models (ultra-large)
  {
    name: 'glm-4.7-flash',
    minVram: 24,
    recommendedTier: 4,
    category: 'general',
    description: 'GLM-4.7 Flash ultra model',
  },
  {
    name: 'qwen3-coder-30b-a3b',
    minVram: 24,
    recommendedTier: 4,
    category: 'code',
    description: 'Qwen3 Coder 30B A3B',
  },
];

/**
 * Cloud-only models (0 VRAM)
 */
export const CLOUD_MODELS: ModelInfo[] = [
  {
    name: 'gemini-2.0-flash',
    minVram: 0,
    recommendedTier: 0,
    category: 'general',
    description: 'Google Gemini 2.0 Flash (cloud-only)',
    isCloud: true,
  },
];

/**
 * Combined catalog including cloud models
 */
export const FULL_CATALOG: ModelInfo[] = [...MODEL_CATALOG, ...CLOUD_MODELS];

/**
 * List all models in catalog
 */
export function listModels(category?: ModelCategory): ModelInfo[] {
  if (category) {
    return FULL_CATALOG.filter((m) => m.category === category);
  }
  return FULL_CATALOG;
}

/**
 * Get compatible models for given VRAM
 */
export function getModelsForVram(vramGb: number): ModelInfo[] {
  return FULL_CATALOG.filter((m) => m.minVram <= vramGb && !m.isCloud);
}

/**
 * Get model by name
 */
export function getModel(name: string): ModelInfo | undefined {
  return FULL_CATALOG.find((m) => m.name === name);
}

/**
 * Pull model from Ollama
 */
export async function pullModel(name: string): Promise<boolean> {
  try {
    // Check if Ollama is running
    execSync('curl -s http://localhost:11434/api/tags', { stdio: 'pipe', timeout: 1000 });
  } catch {
    throw new Error('Ollama is not running. Start it with: ollama serve');
  }

  try {
    console.log(`Pulling model ${name}...`);
    execSync(`ollama pull ${name}`, { stdio: 'inherit' });
    return true;
  } catch (error) {
    throw new Error(`Failed to pull model ${name}: ${error}`);
  }
}

/**
 * Get models currently available in Ollama
 */
export function getLocalModels(): string[] {
  try {
    const response = execSync('curl -s http://localhost:11434/api/tags', { encoding: 'utf-8' });
    const data = JSON.parse(response) as OllamaTagsResponse;
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Check if a model is available locally
 */
export function isModelAvailable(name: string): boolean {
  const localModels = getLocalModels();
  return localModels.includes(name);
}

/**
 * Get recommended model for tier
 */
export function getRecommendedModel(tier: number, category?: ModelCategory): ModelInfo | undefined {
  let models = getModelsForVram(tier * 16); // Rough estimate: tier * 16GB
  if (category) {
    models = models.filter((m) => m.category === category);
  }

  // Sort by recommended tier (ascending) and VRAM (descending)
  models.sort((a, b) => {
    if (a.recommendedTier !== b.recommendedTier) {
      return a.recommendedTier - b.recommendedTier;
    }
    return b.minVram - a.minVram;
  });

  return models[0];
}

/**
 * Get full model catalog
 */
export function getModelCatalog(): ModelInfo[] {
  return [...MODEL_CATALOG];
}

/**
 * Get model by name
 */
export function getModelByName(name: string): ModelInfo | null {
  return MODEL_CATALOG.find((m) => m.name === name) || null;
}

