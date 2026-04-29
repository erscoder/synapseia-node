/**
 * LangGraph LLM Service
 * NestJS injectable wrapper for LLM generation
 * Sprint B - Planning + Self-Critique
 */

import { Injectable } from '@nestjs/common';
import { traceable } from 'langsmith/traceable';
import { LlmProviderHelper, type LLMModel, type LLMConfig } from '../../llm/llm-provider';

@Injectable()
export class LangGraphLlmService {
  private readonly tracedGenerate: (model: LLMModel, prompt: string, config?: LLMConfig) => Promise<string>;
  private readonly tracedGenerateJson: (model: LLMModel, prompt: string, config?: LLMConfig) => Promise<string>;

  constructor(private readonly llmProviderHelper: LlmProviderHelper) {
    // LangSmith `traceable` is a no-op when LANGCHAIN_TRACING_V2 is unset
    // (a few µs of function-call overhead, no I/O). DEV-only: opt in via
    // env var when debugging a specific run locally; never enable in
    // production — traces leak prompt + LLM output to LangChain Inc and
    // break Synapseia's per-node trust model. See `.env.example`.
    this.tracedGenerate = traceable(
      async (model: LLMModel, prompt: string, config?: LLMConfig) =>
        this.llmProviderHelper.generateLLM(model, prompt, config),
      { name: 'llm.generate', run_type: 'llm' },
    );
    this.tracedGenerateJson = traceable(
      async (model: LLMModel, prompt: string, config?: LLMConfig) =>
        this.llmProviderHelper.generateLLM(model, prompt, config, { forceJson: true }),
      { name: 'llm.generateJSON', run_type: 'llm' },
    );
  }

  async generate(model: LLMModel, prompt: string, config?: LLMConfig): Promise<string> {
    return this.tracedGenerate(model, prompt, config);
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
    return this.tracedGenerateJson(model, prompt, config);
  }
}
