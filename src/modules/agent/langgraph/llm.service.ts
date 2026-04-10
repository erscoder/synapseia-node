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

  /**
   * Like `generate` but enables constrained JSON decoding (Ollama format:"json",
   * OpenAI-compat response_format:"json_object"). The model is physically
   * prevented from emitting non-JSON tokens, so the output can be passed
   * directly to JSON.parse without multi-pass cleaning logic.
   *
   * Note: this only guarantees syntactic validity — field validation is still
   * the caller's responsibility. For providers that don't support JSON mode
   * (Anthropic, Moonshot) this falls back to a plain generate; those models
   * follow JSON instructions reliably enough that extra parsing is unnecessary.
   */
  async generateJSON(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
    return this.llmProviderHelper.generateLLM(model, prompt, config, { forceJson: true });
  }
}
