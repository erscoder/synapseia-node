import {
  type ChatRequest,
  type LLMResponseAdapter,
  type NormalizedResponse,
  type FinishReason,
  defaultErrorMessage,
  readArray,
  readNumber,
  readString,
} from './llm-response-adapter';

const FINISH_REASON_MAP: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content_filter',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
};

/**
 * Shared base for chat APIs that ship a strict OpenAI-compatible
 * response (Moonshot/Kimi, MiniMax, Zhipu/GLM, and most Chinese-vendor
 * gateways). Vendor-specific quirks are layered on top via the optional
 * `validateResponseBody` hook called before `parseResponse` runs the
 * standard `choices[0].message.content` extraction.
 *
 * Subclasses must declare `providerId`, `endpoint`, and `apiKeyEnvVar`
 * via the providers.ts table; this base only handles wire-protocol
 * mechanics and does not look those up itself (kept loosely coupled so
 * the providers table can evolve without touching adapters).
 */
export abstract class OpenAICompatAdapter implements LLMResponseAdapter {
  abstract readonly providerId: string;
  protected abstract readonly endpoint: string;

  /**
   * Optional vendor pre-check. If implemented, it runs before the
   * standard choices/message parser and may throw on application-level
   * errors that the vendor encodes in a 200-OK body (e.g. MiniMax's
   * `base_resp.status_code`).
   */
  protected validateResponseBody?(body: unknown): void;

  /** Subclasses can extend if they need extra Authorization shapes. */
  protected buildHeaders(req: ChatRequest): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${req.apiKey}`,
    };
  }

  buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.hyperparams?.temperature !== undefined) body.temperature = req.hyperparams.temperature;
    if (req.hyperparams?.maxTokens !== undefined) body.max_tokens = req.hyperparams.maxTokens;
    if (req.hyperparams?.forceJson) body.response_format = { type: 'json_object' };
    return {
      url: this.endpoint,
      init: {
        method: 'POST',
        headers: this.buildHeaders(req),
        body: JSON.stringify(body),
      },
    };
  }

  parseResponse(_httpStatus: number, body: unknown): NormalizedResponse {
    if (this.validateResponseBody) this.validateResponseBody(body);
    const choices = readArray(body, 'choices');
    if (choices.length === 0) {
      throw new Error(`${this.providerId} response had no choices[]`);
    }
    const choice = choices[0];
    const content = readString(choice, 'message', 'content');
    if (typeof content !== 'string' || content.length === 0) {
      const finish = readString(choice, 'finish_reason') ?? 'unknown';
      throw new Error(
        `${this.providerId} returned no message.content (finish_reason=${finish})`,
      );
    }
    const finishStr = readString(choice, 'finish_reason') ?? 'stop';
    return {
      text: content,
      finishReason: FINISH_REASON_MAP[finishStr] ?? 'unknown',
      usage: {
        promptTokens: readNumber(body, 'usage', 'prompt_tokens'),
        completionTokens: readNumber(body, 'usage', 'completion_tokens'),
        totalTokens: readNumber(body, 'usage', 'total_tokens'),
      },
      raw: body,
    };
  }

  parseError(httpStatus: number, body: unknown, fallbackText?: string): Error {
    return new Error(defaultErrorMessage(httpStatus, body, fallbackText));
  }
}
