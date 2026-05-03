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
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  BLOCKLIST: 'content_filter',
  LANGUAGE: 'content_filter',
  OTHER: 'unknown',
  TOOL_CODE_FAILURE: 'tool_calls',
};

/**
 * Adapter for the Google Gemini generateContent API.
 *
 * Endpoint pattern: POST .../models/{model}:generateContent
 * Auth: header `x-goog-api-key: <key>` (we avoid the `?key=` query
 * param so the key never lands in fetch logs / proxy access logs).
 *
 * Response shape:
 *   {
 *     "candidates": [
 *       {
 *         "content": {
 *           "role": "model",
 *           "parts": [
 *             { "text": "Hello" },
 *             { "thought": true, "text": "<reasoning>" },   // thinking models
 *             { "functionCall": { "name": "...", "args": {} } }
 *           ]
 *         },
 *         "finishReason": "STOP" | "MAX_TOKENS" | "SAFETY" | ...,
 *         "safetyRatings": [...]
 *       }
 *     ],
 *     "promptFeedback": { "blockReason": "SAFETY", "safetyRatings": [...] },
 *     "usageMetadata": { "promptTokenCount": .., "candidatesTokenCount": ..,
 *                        "totalTokenCount": .. }
 *   }
 *
 * If `promptFeedback.blockReason` is set the prompt itself was rejected
 * before the model ran — surface that distinctly from a normal refusal.
 * Within `parts`, parts with `thought: true` are reasoning traces and we
 * skip them. We also skip `functionCall` parts (no tool support yet).
 */
export class GoogleAdapter implements LLMResponseAdapter {
  readonly providerId = 'google';

  buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
    const entry = CLOUD_PROVIDERS_BY_ID.get('google');
    if (!entry) throw new Error('google provider not registered');
    const url = entry.endpoint.replace('{model}', encodeURIComponent(req.model));
    const generationConfig: Record<string, unknown> = {};
    if (req.hyperparams?.temperature !== undefined) {
      generationConfig.temperature = req.hyperparams.temperature;
    }
    if (req.hyperparams?.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = req.hyperparams.maxTokens;
    }
    if (req.hyperparams?.forceJson) {
      generationConfig.responseMimeType = 'application/json';
    }
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    };
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': req.apiKey,
        },
        body: JSON.stringify(body),
      },
    };
  }

  parseResponse(_httpStatus: number, body: unknown): NormalizedResponse {
    const blockReason = readString(body, 'promptFeedback', 'blockReason');
    if (blockReason) {
      throw new Error(`Google blocked the prompt: blockReason=${blockReason}`);
    }
    const candidates = readArray(body, 'candidates');
    if (candidates.length === 0) {
      throw new Error('Google response had no candidates[]');
    }
    const candidate = candidates[0];
    const finishStr = readString(candidate, 'finishReason') ?? 'STOP';
    const parts = readArray(candidate, 'content', 'parts');
    const textParts: string[] = [];
    for (const part of parts) {
      // `thought: true` flags a reasoning trace — discard it. We only
      // collect plain `text` parts that aren't reasoning and aren't
      // function calls.
      if (readString(part, 'functionCall', 'name')) continue;
      const isThought = (part as Record<string, unknown>)?.thought === true;
      if (isThought) continue;
      const t = readString(part, 'text');
      if (t) textParts.push(t);
    }
    if (textParts.length === 0) {
      throw new Error(
        `Google returned no text parts (finishReason=${finishStr}); ` +
          `function-call / thought-only responses are not consumable by this node`,
      );
    }
    return {
      text: textParts.join(''),
      finishReason: FINISH_REASON_MAP[finishStr] ?? 'unknown',
      usage: {
        promptTokens: readNumber(body, 'usageMetadata', 'promptTokenCount'),
        completionTokens: readNumber(body, 'usageMetadata', 'candidatesTokenCount'),
        totalTokens: readNumber(body, 'usageMetadata', 'totalTokenCount'),
      },
      raw: body,
    };
  }

  parseError(httpStatus: number, body: unknown, fallbackText?: string): Error {
    // Google shape: { "error": { "code": 400, "message": "...", "status": "INVALID_ARGUMENT" } }
    const msg = readString(body, 'error', 'message');
    if (msg) return new Error(`HTTP ${httpStatus}: ${msg}`);
    return new Error(defaultErrorMessage(httpStatus, body, fallbackText));
  }
}
