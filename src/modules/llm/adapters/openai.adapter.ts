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
import { CLOUD_PROVIDERS_BY_ID } from '../providers';

const FINISH_REASON_MAP: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content_filter',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
};

/**
 * Adapter for the official OpenAI Chat Completions API.
 *
 * Response shape (POST /v1/chat/completions):
 *   {
 *     "id": "chatcmpl-...",
 *     "object": "chat.completion",
 *     "model": "gpt-5",
 *     "choices": [
 *       { "index": 0, "finish_reason": "stop",
 *         "message": { "role": "assistant", "content": "..." } }
 *     ],
 *     "usage": { "prompt_tokens": .., "completion_tokens": .., "total_tokens": .. }
 *   }
 *
 * `choices[0].message.content` is null when the assistant produced a
 * tool_call or refusal (`message.refusal: "..."`). Both are surfaced as
 * thrown errors so the caller doesn't get an empty string.
 *
 * Reasoning models (o-series, gpt-5 with reasoning) keep the final answer
 * in `message.content`; the reasoning trace lives in a separate
 * `reasoning_content` (or `usage.completion_tokens_details.reasoning_tokens`
 * for telemetry only). We discard reasoning here.
 */
export class OpenAIAdapter implements LLMResponseAdapter {
  readonly providerId = 'openai';

  buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
    const entry = CLOUD_PROVIDERS_BY_ID.get('openai');
    if (!entry) throw new Error('openai provider not registered');
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.hyperparams?.temperature !== undefined) body.temperature = req.hyperparams.temperature;
    if (req.hyperparams?.maxTokens !== undefined) body.max_tokens = req.hyperparams.maxTokens;
    if (req.hyperparams?.forceJson) body.response_format = { type: 'json_object' };
    return {
      url: entry.endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${req.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    };
  }

  parseResponse(_httpStatus: number, body: unknown): NormalizedResponse {
    const choices = readArray(body, 'choices');
    if (choices.length === 0) {
      throw new Error('OpenAI response had no choices[]');
    }
    const choice = choices[0];
    const refusal = readString(choice, 'message', 'refusal');
    if (refusal) {
      throw new Error(`OpenAI refused to answer: ${refusal}`);
    }
    const content = readString(choice, 'message', 'content');
    if (typeof content !== 'string' || content.length === 0) {
      // null content with tool_calls is a legitimate path on the API but
      // not one we know how to handle yet — surface it loudly instead of
      // returning an empty string and corrupting downstream pipelines.
      const finish = readString(choice, 'finish_reason') ?? 'unknown';
      throw new Error(
        `OpenAI returned no message.content (finish_reason=${finish}); ` +
          `tool_calls/multimodal responses are not supported by this node`,
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
