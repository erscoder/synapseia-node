/**
 * Strategy interface for translating between Synapseia's neutral chat
 * request shape and each cloud LLM provider's wire protocol.
 *
 * Every adapter owns:
 *   - request shaping (URL, headers, body)
 *   - response parsing (extract assistant text from heterogeneous schemas)
 *   - error parsing (turn HTTP errors into thrown Error with useful msg)
 *   - transient classification (retry vs fail-fast)
 *
 * The dispatcher in llm-provider.ts calls these in sequence and the
 * adapter never touches `fetch` or `setTimeout` itself, which keeps the
 * adapters trivially mockable in unit tests.
 */

export interface ChatHyperparams {
  temperature?: number;
  maxTokens?: number;
  /** Force the response to be a JSON object (provider-dependent semantics). */
  forceJson?: boolean;
}

export interface ChatRequest {
  /** Vendor-specific model id, e.g. "gpt-5", "claude-opus-4-7", "gemini-2.5-pro". */
  model: string;
  prompt: string;
  apiKey: string;
  hyperparams?: ChatHyperparams;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'unknown';

export interface NormalizedResponse {
  /** The final user-facing assistant text, with reasoning blocks already stripped. */
  text: string;
  finishReason: FinishReason;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Raw provider body, kept for debug log lines only — never exposed to callers. */
  raw?: unknown;
}

export interface LLMResponseAdapter {
  readonly providerId: string;
  /** Build the HTTP request that should be sent for this prompt. */
  buildRequest(req: ChatRequest): { url: string; init: RequestInit };
  /**
   * Parse a successful (HTTP 2xx) response body. Adapters MUST throw if
   * the body looks structurally wrong (missing required fields, only
   * thinking/tool_use blocks, application-level error encoded in 200,
   * etc.) — the dispatcher relies on exceptions to trigger retries.
   */
  parseResponse(httpStatus: number, body: unknown): NormalizedResponse;
  /** Turn a non-2xx response into an Error with the most useful message available. */
  parseError(httpStatus: number, body: unknown, fallbackText?: string): Error;
  /** Provider-specific transient signals on top of the shared isTransientLlmError(). */
  isTransientError?(err: unknown): boolean;
}

/**
 * Read a string field from an object even when the typing says `unknown`.
 * Adapter parsing is deeply nested and TypeScript narrowing gets in the way;
 * this helper avoids `as any` sprinkles at every step.
 */
export function readString(obj: unknown, ...path: (string | number)[]): string | undefined {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Read a number field, same semantics as readString. */
export function readNumber(obj: unknown, ...path: (string | number)[]): number | undefined {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return typeof cur === 'number' ? cur : undefined;
}

/** Read an array field, returns [] when the path doesn't lead to an array. */
export function readArray(obj: unknown, ...path: (string | number)[]): unknown[] {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return [];
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return Array.isArray(cur) ? cur : [];
}

/**
 * Best-effort error-message extraction. Vendors all use a different shape
 * (`error.message` for OpenAI/Anthropic/Moonshot, `error.message` at top
 * level for Google, `base_resp.status_msg` for MiniMax). Adapters override
 * this when they can do better; the default covers the OpenAI family.
 */
export function defaultErrorMessage(httpStatus: number, body: unknown, fallbackText?: string): string {
  const err =
    readString(body, 'error', 'message') ??
    readString(body, 'message') ??
    readString(body, 'error');
  if (err) return `HTTP ${httpStatus}: ${err}`;
  if (fallbackText) {
    const snippet = fallbackText.replace(/\s+/g, ' ').trim().slice(0, 200);
    return `HTTP ${httpStatus}: ${snippet}`;
  }
  return `HTTP ${httpStatus}`;
}
