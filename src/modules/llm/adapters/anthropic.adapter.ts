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

const STOP_REASON_MAP: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Adapter for the Anthropic Messages API.
 *
 * Response shape (POST /v1/messages):
 *   {
 *     "id": "msg_...",
 *     "type": "message",
 *     "role": "assistant",
 *     "model": "claude-sonnet-4-6",
 *     "content": [
 *       { "type": "thinking", "thinking": "..." },     // only with extended thinking
 *       { "type": "text", "text": "Hello..." },
 *       { "type": "tool_use", "id": "...", "name": "...", "input": {...} }  // tools only
 *     ],
 *     "stop_reason": "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal",
 *     "usage": { "input_tokens": .., "output_tokens": .., "cache_read_input_tokens": .. }
 *   }
 *
 * The block array is heterogeneous. We concatenate every `text` block in
 * order, ignoring `thinking`, `redacted_thinking`, `tool_use` and any
 * future block types. If we end up with an empty string we throw rather
 * than silently return "" — that almost always means the model decided
 * to call a tool and we have no logic for that yet.
 */
export class AnthropicAdapter implements LLMResponseAdapter {
  readonly providerId = 'anthropic';

  buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
    const entry = CLOUD_PROVIDERS_BY_ID.get('anthropic');
    if (!entry) throw new Error('anthropic provider not registered');
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.hyperparams?.maxTokens ?? 4096,
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.hyperparams?.temperature !== undefined) body.temperature = req.hyperparams.temperature;
    return {
      url: entry.endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': req.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          // Required when the request runs from a browser-like environment;
          // Tauri / Electron embedded fetch occasionally tags itself as such.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      },
    };
  }

  parseResponse(_httpStatus: number, body: unknown): NormalizedResponse {
    const blocks = readArray(body, 'content');
    if (blocks.length === 0) {
      throw new Error('Anthropic response had no content[] blocks');
    }
    const textParts: string[] = [];
    for (const block of blocks) {
      const type = readString(block, 'type');
      if (type === 'text') {
        const t = readString(block, 'text');
        if (t) textParts.push(t);
      }
      // Intentionally ignore: thinking, redacted_thinking, tool_use,
      // server_tool_use, web_search_tool_result, image, document.
    }
    if (textParts.length === 0) {
      const stop = readString(body, 'stop_reason') ?? 'unknown';
      throw new Error(
        `Anthropic returned no text blocks (stop_reason=${stop}); ` +
          `tool_use / thinking-only responses are not consumable by this node`,
      );
    }
    const stopStr = readString(body, 'stop_reason') ?? 'end_turn';
    return {
      text: textParts.join(''),
      finishReason: STOP_REASON_MAP[stopStr] ?? 'unknown',
      usage: {
        promptTokens: readNumber(body, 'usage', 'input_tokens'),
        completionTokens: readNumber(body, 'usage', 'output_tokens'),
        // Anthropic doesn't publish a total — it's input + output and we
        // expose it pre-computed for parity with OpenAI usage telemetry.
        totalTokens: (readNumber(body, 'usage', 'input_tokens') ?? 0) +
          (readNumber(body, 'usage', 'output_tokens') ?? 0) || undefined,
      },
      raw: body,
    };
  }

  parseError(httpStatus: number, body: unknown, fallbackText?: string): Error {
    // Anthropic shape: { "type": "error", "error": { "type": "...", "message": "..." } }
    const msg =
      readString(body, 'error', 'message') ??
      readString(body, 'message');
    if (msg) return new Error(`HTTP ${httpStatus}: ${msg}`);
    return new Error(defaultErrorMessage(httpStatus, body, fallbackText));
  }
}
