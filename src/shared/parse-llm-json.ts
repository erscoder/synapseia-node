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
 * Tolerant repair pass for common LLM-emitted JSON pathologies. Run on the
 * already-extracted balanced substring before a second JSON.parse attempt.
 *
 * Step 3 (2026-04-30) — covers the residual error families observed in
 * `node_telemetry_events` after the Step 1 sweep:
 *   1. Single-line `// ...` and block `/* ... *\/` comments left in by chatty models.
 *   2. Trailing commas before `]` or `}` (legal JS, illegal JSON).
 *   3. Truncated trailing string at context-budget cutoff — close with `"` and
 *      add a matching `}` if the structure is otherwise salvageable.
 *
 * Comment stripping is string-literal-aware so comment markers inside `"..."`
 * are preserved; the same scan rules `extractFirstJsonStructure` uses.
 *
 * Returns the repaired string (or the input verbatim if no repair was
 * applicable). Never throws.
 */
export function repairLlmJson(s: string): string {
  if (!s) return s;

  // Pass 1: strip line and block comments outside string literals.
  let out = '';
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inStr) {
      out += ch;
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    // Line comment // ... newline
    if (ch === '/' && next === '/') {
      const eol = s.indexOf('\n', i + 2);
      i = eol === -1 ? s.length : eol; // skip up to (and excluding) newline
      continue;
    }
    // Block comment /* ... */
    if (ch === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 1; // skip past closing slash
      continue;
    }
    out += ch;
  }

  // Pass 2: drop trailing commas before `]` or `}` (re-walking the cleaned
  // string is cheaper than threading state through pass 1).
  let pass2 = '';
  inStr = false;
  escape = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inStr) {
      pass2 += ch;
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; pass2 += ch; continue; }
    if (ch === ',') {
      // Look ahead past whitespace for the next non-ws char.
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (j < out.length && (out[j] === '}' || out[j] === ']')) {
        // skip the trailing comma
        continue;
      }
    }
    pass2 += ch;
  }

  // Pass 3: detect truncation. If the string ends inside an unterminated
  // string literal, close it; if depth > 0, append matching `}`/`]`.
  let depth = 0;
  let bracketDepth = 0;
  inStr = false;
  escape = false;
  for (let i = 0; i < pass2.length; i++) {
    const ch = pass2[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
  }
  if (inStr) pass2 += '"';
  while (bracketDepth > 0) { pass2 += ']'; bracketDepth--; }
  while (depth > 0) { pass2 += '}'; depth--; }

  return pass2;
}

/**
 * Strip a code-fenced wrapper — ```json\n…\n``` , ```JSON\n…``` , or a bare
 * ```\n…\n``` fence — and return the inner payload. Returns the input
 * verbatim if no fence is detected. Tolerant of missing trailing fence
 * (truncation) and of language-tag casing.
 */
export function stripCodeFence(s: string): string {
  if (!s) return s;
  // Match opening fence with optional language tag, capture the body up to
  // the next fence or end of string.
  const m = s.match(/^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)(?:\n?```|$)/);
  if (m && m[1]) return m[1].trim();
  return s;
}

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

  // Step 3 (2026-04-30): broaden code-fence stripping (catches ```JSON,
  // bare ``` fences, and missing trailing fence) before extracting the
  // balanced structure. The original regex `/^\s*```json\s*…/` only
  // matched the lowercase tagged variant.
  const fenceStripped = stripCodeFence(cleaned);
  const balanced = extractFirstJsonStructure(fenceStripped);
  if (balanced) {
    try {
      const value = JSON.parse(balanced) as T;
      return { ok: true, value, cleaned, recoveredFrom: 'extraction' };
    } catch { /* fall through to repair */ }

    // Step 3: tolerant repair pass for trailing commas, comments, and
    // truncated strings. Cheaper than introducing a runtime dependency
    // for a 40-line problem space.
    try {
      const repaired = repairLlmJson(balanced);
      const value = JSON.parse(repaired) as T;
      return { ok: true, value, cleaned, recoveredFrom: 'extraction' };
    } catch { /* fall through to repair-on-raw */ }
  }

  // Step 3 fallback: when the input is so badly truncated that
  // `extractFirstJsonStructure` couldn't find a balanced span (e.g.
  // `{"a":1,"b":"truncated`), still try `repairLlmJson` on the
  // fence-stripped raw — repair will close the string and append the
  // missing `}` so JSON.parse can succeed.
  try {
    const repaired = repairLlmJson(fenceStripped);
    const value = JSON.parse(repaired) as T;
    return { ok: true, value, cleaned, recoveredFrom: 'extraction' };
  } catch { /* fall through to total failure */ }

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
