/**
 * Robust JSON parser for LLM outputs.
 *
 * Different providers ship different levels of strictness around
 * `response_format:"json_object"` / `format:"json"`:
 *   - Ollama with `format:"json"` and OpenAI gpt-4-turbo+ with
 *     `response_format:"json_object"` are strict.
 *   - Anthropic Claude has no native JSON mode -- depends on prompt.
 *   - Google Gemini Pro/Flash recent models honour JSON mode; older ones don't.
 *   - MiniMax-M2.7 cloud (observed 2026-04-27) ignores response_format and
 *     emits `{...valid JSON...} trailing prose` or two stacked objects.
 *   - Local Llama/Mistral without `format:` are entirely freeform.
 *
 * This helper is the single chokepoint every node-side LLM consumer
 * should run output through:
 *   1. `stripReasoning` removes <think>/<reasoning>/scratchpad envelopes.
 *   2. `JSON.parse` is attempted on the cleaned string.
 *   3. On failure, `extractFirstJsonStructure` recovers the first
 *      balanced `{...}` or `[...]` substring and reparses.
 *   4. On total failure, returns `null` -- callers decide the fallback.
 */

import { stripReasoning } from './sanitize-llm-output';

/**
 * Walk `s` starting at the first `{` or `[` and return the first balanced
 * structure as a substring. Honours string literals (so braces/brackets
 * inside `"..."` don't shift depth) and escaped quotes (`\"`). Returns
 * null when no balanced structure is found.
 *
 * Why not regex: regex cannot match balanced delimiters in the general
 * case. A simple linear scan with a depth counter is both correct and
 * O(n) over the input.
 */
export function extractFirstJsonStructure(s: string): string | null {
  // Find the earliest opening delimiter.
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  let start: number;
  let open: '{' | '[';
  let close: '}' | ']';
  if (firstBrace < 0 && firstBracket < 0) return null;
  if (firstBrace < 0) {
    start = firstBracket;
    open = '[';
    close = ']';
  } else if (firstBracket < 0 || firstBrace < firstBracket) {
    start = firstBrace;
    open = '{';
    close = '}';
  } else {
    start = firstBracket;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export interface ParseLlmJsonResult<T> {
  ok: boolean;
  value: T | null;
  /** Original cleaned-of-reasoning string actually fed to JSON.parse */
  cleaned: string;
  /** First parse error message (only when both attempts failed) */
  error?: string;
  /** When the raw envelope failed and recovery succeeded, the recovered substring */
  recoveredFrom?: 'envelope' | 'extraction';
}

/**
 * Parse an LLM-emitted JSON payload tolerantly.
 *
 * Returns `{ok: false, value: null}` when both the raw envelope AND the
 * balanced-structure extraction fail. The caller decides how to fall back
 * (e.g. treat as direct answer, fall back to legacy executor, etc).
 *
 * Use the typed value with care: this helper does NOT validate the shape
 * of `T` -- it only guarantees JSON well-formedness. Add a separate schema
 * check (zod, manual field validation, etc.) when shape matters.
 */
export function parseLlmJson<T>(raw: unknown): ParseLlmJsonResult<T> {
  const cleaned = stripReasoning(raw).trim();
  if (cleaned.length === 0) {
    return { ok: false, value: null, cleaned, error: 'empty input' };
  }

  let firstError: Error | null = null;
  try {
    const value = JSON.parse(cleaned) as T;
    return { ok: true, value, cleaned, recoveredFrom: 'envelope' };
  } catch (err) {
    firstError = err as Error;
  }

  const balanced = extractFirstJsonStructure(cleaned);
  if (balanced) {
    try {
      const value = JSON.parse(balanced) as T;
      return { ok: true, value, cleaned, recoveredFrom: 'extraction' };
    } catch { /* fall through to total failure */ }
  }

  return { ok: false, value: null, cleaned, error: firstError?.message ?? 'unknown parse error' };
}

/**
 * Build an 80-char snippet of the trailing garbage starting at the
 * position reported in the JSON.parse error message. Useful for warn
 * logs so operators can see what the provider is appending after the
 * JSON envelope.
 */
export function jsonParseTailSnippet(cleaned: string, errorMessage: string | undefined): string {
  if (!errorMessage) return '';
  const match = errorMessage.match(/position\s+(\d+)/);
  if (!match) return '';
  const pos = parseInt(match[1], 10);
  if (!Number.isFinite(pos) || pos < 0) return '';
  return cleaned.slice(pos, pos + 80).replace(/\s+/g, ' ');
}
