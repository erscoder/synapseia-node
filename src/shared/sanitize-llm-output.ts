/**
 * Sanitize LLM output before any node-side consumption.
 *
 * Mirrors the coordinator's llm-output sanitizer (kept intentionally duplicated
 * to avoid cross-package imports — the node package must not depend on
 * coordinator source). Applied inside LlmProviderHelper.generateLLM so every
 * downstream caller (research, classify, summarize, mutation engine, langgraph
 * nodes) gets clean text without needing to remember to strip locally.
 *
 * Handles:
 *   - closed <think>...</think>, <thinking>...</thinking>, <reasoning>, <scratchpad>
 *   - unclosed opening tags (model truncated by num_predict / max_tokens)
 *   - OpenAI-style channel markers (<|start_of_thinking|>…<|end_of_thinking|>)
 */

const REASONING_PATTERNS: RegExp[] = [
  /<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi,
  /<\|(?:start_of_thinking|reasoning|scratchpad|thought)\|>[\s\S]*?<\|end_of_(?:thinking|reasoning|scratchpad|thought)\|>/gi,
];

const UNCLOSED_REASONING_PATTERNS: RegExp[] = [
  /<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*$/i,
  /<\|(?:start_of_thinking|reasoning|scratchpad|thought)\|>[\s\S]*$/i,
];

/**
 * Remove reasoning-model scratchpad output from a raw LLM string.
 * Idempotent: safe to run on already-clean strings.
 */
export function stripReasoning(input: unknown): string {
  if (input == null) return '';
  const text = typeof input === 'string' ? input : String(input);

  let out = text;
  for (const re of REASONING_PATTERNS) out = out.replace(re, '');
  for (const re of UNCLOSED_REASONING_PATTERNS) out = out.replace(re, '');
  return out.trim();
}
