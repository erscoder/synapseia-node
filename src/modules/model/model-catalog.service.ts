import { Injectable } from '@nestjs/common';
import {
  listModels,
  getModelsForVram,
  getModel,
  pullModel,
  getLocalModels,
  isModelAvailable,
  getRecommendedModel,
  getModelCatalog,
  normalizeModelName,
  getModelByName,
  MODEL_CATALOG,
  CLOUD_MODELS,
  FULL_CATALOG,
  type ModelInfo,
  type ModelCategory,
} from '../../model-catalog.js';

@Injectable()
export class ModelCatalogService {
  list(category?: ModelCategory): ModelInfo[] {
    return listModels(category);
  }

  getForVram(vramGb: number): ModelInfo[] {
    return getModelsForVram(vramGb);
  }

  get(name: string): ModelInfo | undefined {
    return getModel(name);
  }

  pull(name: string): Promise<boolean> {
    return pullModel(name);
  }

  getLocal(): string[] {
    return getLocalModels();
  }

  isAvailable(name: string): boolean {
    return isModelAvailable(name);
  }

  getRecommended(tier: number, category?: ModelCategory): ModelInfo | undefined {
    return getRecommendedModel(tier, category);
  }

  getCatalog(): ModelInfo[] {
    return getModelCatalog();
  }

  normalizeName(name: string): string {
    return normalizeModelName(name);
  }

  getByName(name: string): ModelInfo | null {
    return getModelByName(name);
  }

  get catalog() {
    return MODEL_CATALOG;
  }

  get cloudModels() {
    return CLOUD_MODELS;
  }

  get fullCatalog() {
    return FULL_CATALOG;
  }
}
