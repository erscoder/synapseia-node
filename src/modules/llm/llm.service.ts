import { Injectable } from '@nestjs/common';
import {
  SUPPORTED_MODELS,
  MODEL_METADATA,
  type LLMModel,
  type LLMStatus,
  type LLMConfig,
} from './helpers/llm-provider.js';
import { LlmProviderHelper } from './helpers/llm-provider.js';
import { OllamaHelper } from './helpers/ollama.js';

@Injectable()
export class LlmService {
  constructor(
    private readonly llmProviderHelper: LlmProviderHelper,
    private readonly ollamaHelper: OllamaHelper,
  ) {}

  parse(modelStr: string): LLMModel | null {
    return this.llmProviderHelper.parseModel(modelStr);
  }

  check(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
    return this.llmProviderHelper.checkLLM(model, config);
  }

  generate(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
    return this.llmProviderHelper.generateLLM(model, prompt, config);
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
}
