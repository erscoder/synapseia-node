/**
 * Model catalog for Synapseia Network
 * Manages LLM models, compatibility, and pulling from Ollama
 */

import { Injectable } from '@nestjs/common';
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
  category?: ModelCategory;
  provider?: 'ollama' | 'cloud';
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
    name: 'locusai/all-minilm-l6-v2',
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
  {
    name: 'Minimax2.7',
    minVram: 0,
    recommendedTier: 0,
    category: 'general',
    description: 'Minimax2.7 (cloud-only)',
    isCloud: true,
  },
  {
    name: 'Kimi2.5',
    minVram: 0,
    recommendedTier: 0,
    category: 'general',
    description: 'Kimi2.5 (cloud-only)',
    isCloud: true,
  },
];

/**
 * Combined catalog including cloud models
 */
export const FULL_CATALOG: ModelInfo[] = [...MODEL_CATALOG, ...CLOUD_MODELS];

@Injectable()
export class ModelCatalogHelper {
  listModels(category?: ModelCategory): ModelInfo[] {
    if (category) return FULL_CATALOG.filter((m) => m.category === category);
    return FULL_CATALOG;
  }

  getModelsForVram(vramGb: number): ModelInfo[] {
    return FULL_CATALOG.filter((m) => m.minVram <= vramGb && !m.isCloud);
  }

  getModel(name: string): ModelInfo | undefined {
    return FULL_CATALOG.find((m) => m.name === name);
  }

  async pullModel(name: string): Promise<boolean> {
    try {
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
   * List locally available Ollama models.
   * @param ollamaUrl - Optional base URL (e.g. `http://ollama:11434`). Falls back to
   *   `OLLAMA_URL` env var, then `http://localhost:11434`. Needed when Ollama runs on
   *   a different host (e.g. Docker Compose, where `localhost` inside the node
   *   container is not the ollama service).
   */
  getLocalModels(ollamaUrl?: string): string[] {
    const baseUrl = ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
    try {
      const response = execSync(`curl -s ${baseUrl}/api/tags`, { encoding: 'utf-8' });
      const data = JSON.parse(response) as OllamaTagsResponse;
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  isModelAvailable(name: string): boolean {
    return this.getLocalModels().includes(name);
  }

  getRecommendedModel(tier: number, category?: ModelCategory): ModelInfo | undefined {
    let models = this.getModelsForVram(tier * 16);
    if (category) models = models.filter((m) => m.category === category);
    models.sort((a, b) => {
      if (a.recommendedTier !== b.recommendedTier) return a.recommendedTier - b.recommendedTier;
      return b.minVram - a.minVram;
    });
    return models[0];
  }

  getModelCatalog(): ModelInfo[] {
    return [...MODEL_CATALOG];
  }

  normalizeModelName(name: string): string {
    return name.replace(/^ollama\//, '').replace(/:/g, '-').toLowerCase();
  }

  getModelByName(name: string): ModelInfo | null {
    const normalized = this.normalizeModelName(name);
    return MODEL_CATALOG.find((m) => m.name === normalized || m.name === name) || null;
  }
}

