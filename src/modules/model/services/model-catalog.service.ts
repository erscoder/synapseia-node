import { Injectable } from '@nestjs/common';
import {
  ModelCatalogHelper,
  MODEL_CATALOG,
  CLOUD_MODELS,
  FULL_CATALOG,
  type ModelInfo,
  type ModelCategory,
} from '../model-catalog.js';

@Injectable()
export class ModelCatalogService {
  constructor(private readonly modelCatalogHelper: ModelCatalogHelper) {}

  list(category?: ModelCategory): ModelInfo[] {
    return this.modelCatalogHelper.listModels(category);
  }

  getForVram(vramGb: number): ModelInfo[] {
    return this.modelCatalogHelper.getModelsForVram(vramGb);
  }

  get(name: string): ModelInfo | undefined {
    return this.modelCatalogHelper.getModel(name);
  }

  pull(name: string): Promise<boolean> {
    return this.modelCatalogHelper.pullModel(name);
  }

  getLocal(): string[] {
    return this.modelCatalogHelper.getLocalModels();
  }

  isAvailable(name: string): boolean {
    return this.modelCatalogHelper.isModelAvailable(name);
  }

  getRecommended(tier: number, category?: ModelCategory): ModelInfo | undefined {
    return this.modelCatalogHelper.getRecommendedModel(tier, category);
  }

  getCatalog(): ModelInfo[] {
    return this.modelCatalogHelper.getModelCatalog();
  }

  normalizeName(name: string): string {
    return this.modelCatalogHelper.normalizeModelName(name);
  }

  getByName(name: string): ModelInfo | null {
    return this.modelCatalogHelper.getModelByName(name);
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
