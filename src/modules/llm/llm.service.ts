import { Injectable } from '@nestjs/common';
import {
  checkLLM,
  generateLLM,
  parseModel,
  SUPPORTED_MODELS,
  MODEL_METADATA,
  type LLMModel,
  type LLMStatus,
  type LLMConfig,
} from '../../llm-provider.js';
import { checkOllama, generate as generateOllama } from '../../ollama.js';

@Injectable()
export class LlmService {
  parse(modelStr: string): LLMModel | null {
    return parseModel(modelStr);
  }

  check(model: LLMModel, config?: LLMConfig): Promise<LLMStatus> {
    return checkLLM(model, config);
  }

  generate(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
    return generateLLM(model, prompt, config);
  }

  checkOllama() {
    return checkOllama();
  }

  generateOllama(prompt: string, modelId: string): Promise<string> {
    return generateOllama(prompt, modelId);
  }

  get supportedModels() {
    return SUPPORTED_MODELS;
  }

  get modelMetadata() {
    return MODEL_METADATA;
  }
}
