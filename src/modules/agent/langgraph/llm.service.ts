/**
 * LangGraph LLM Service
 * NestJS injectable wrapper for LLM generation
 * Sprint B - Planning + Self-Critique
 */

import { Injectable } from '@nestjs/common';
import { LlmProviderHelper, type LLMModel, type LLMConfig } from '../../llm/llm-provider';

@Injectable()
export class LangGraphLlmService {
  constructor(private readonly llmProviderHelper: LlmProviderHelper) {}

  async generate(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
    return this.llmProviderHelper.generateLLM(model, prompt, config);
  }
}
