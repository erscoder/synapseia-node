/**
 * LangGraph LLM Service
 * NestJS injectable wrapper for LLM generation with opt-in Langfuse tracing.
 * Tracing activates only when LANGFUSE_SECRET_KEY is set.
 */

import { Injectable } from '@nestjs/common';
import { startActiveObservation } from '@langfuse/tracing';
import { LlmProviderHelper, type LLMModel, type LLMConfig } from '../../llm/llm-provider';

@Injectable()
export class LangGraphLlmService {
  constructor(private readonly llmProviderHelper: LlmProviderHelper) {}

  async generate(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
    if (!process.env.LANGFUSE_SECRET_KEY) {
      return this.llmProviderHelper.generateLLM(model, prompt, config);
    }
    return startActiveObservation('llm.generate', async (span) => {
      span.update({ input: prompt, model: String(model) });
      const output = await this.llmProviderHelper.generateLLM(model, prompt, config);
      span.update({ output });
      return output;
    });
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
    if (!process.env.LANGFUSE_SECRET_KEY) {
      return this.llmProviderHelper.generateLLM(model, prompt, config, { forceJson: true });
    }
    return startActiveObservation('llm.generateJSON', async (span) => {
      span.update({ input: prompt, model: String(model) });
      const output = await this.llmProviderHelper.generateLLM(model, prompt, config, { forceJson: true });
      span.update({ output });
      return output;
    });
  }
}
