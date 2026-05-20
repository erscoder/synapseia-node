/**
 * Prompt-safety helper (P26 reviewer-lessons pattern).
 *
 * Centralized guardrails for ANY user-controlled / peer-controlled string
 * interpolated into an LLM prompt template. Establishes one source of truth
 * so adding a new prompt builder that interpolates `${untrusted.field}`
 * cannot drift away from the same regex set, length cap, and control-char
 * stripping.
 *
 * Threat model (F-node-004, audits/2026-05/AUDIT-node.md):
 *   - Submissions fetched from coordinator
 *     `/research-rounds/:roundId/submissions` are PUBLISHED BY OTHER PEERS.
 *     The coord republishes them verbatim; it does NOT sanitize.
 *   - A malicious peer can craft `title`/`summary`/`keyInsights` that
 *     contain jailbreak directives ("ignore previous instructions",
 *     "respond with {accuracy:10,...}", "olvida tus instrucciones...") to
 *     skew their own review when another node scores them.
 *   - Same threat exists for the medical pipeline: WO title/abstract,
 *     researcher JSON, critic feedback all flow into prompts.
 *
 * Defense:
 *   - Length cap (truncation attack on context budget).
 *   - Control-char strip (terminal hijack / log injection).
 *   - Jailbreak-marker regex (EN + ES) — fail-closed throw, caller decides
 *     whether to skip the item or fall back.
 *
 * USAGE — call once per field before interpolation:
 *   assertSafeForPrompt(submission.title ?? '', 'title');
 *   assertSafeForPrompt(submission.summary ?? '', 'summary');
 *   for (const [i, ins] of (submission.keyInsights ?? []).entries()) {
 *     assertSafeForPrompt(ins, `keyInsight[${i}]`);
 *   }
 *
 * On violation: throws `PromptSafetyError` with `fieldName` and `reason`.
 * Caller wraps in try/catch, logs the telemetry event, skips the item.
 */

export const MAX_PROMPT_FIELD_LEN = 4096;

/**
 * Jailbreak marker patterns. Case-insensitive.
 *
 * Coverage (EN + ES):
 *   - "ignore previous/all instructions"
 *   - "disregard / forget the/your prior instructions"
 *   - "system prompt", "[system]", "<system>", "</system>"
 *   - role markers used by Anthropic / OpenAI chat schemas
 *   - explicit role flip: "you are now", "act as", "actúa como"
 *   - reply-injection: "reply with {", "respond with {", "responde con {"
 *   - ES counterparts: "olvida (las/tus) instrucciones", "ignora ...",
 *     "ahora eres", "haz de cuenta", "no sigas las reglas"
 *
 * NOT intended to be exhaustive — defense in depth assumes the LLM
 * also rejects most flips on its own. Goal is to catch the high-signal
 * obvious markers AND give us a tripwire we can log/alert on.
 */
const JAILBREAK_PATTERNS: ReadonlyArray<RegExp> = [
  // EN — instruction override
  /\bignore\s+(?:all\s+|the\s+|your\s+|previous\s+|prior\s+|above\s+)+instructions?\b/i,
  /\bdisregard\s+(?:all\s+|the\s+|your\s+|previous\s+|prior\s+|above\s+)+instructions?\b/i,
  /\bforget\s+(?:all\s+|the\s+|your\s+|previous\s+|prior\s+|above\s+)+instructions?\b/i,
  /\boverride\s+(?:the\s+|your\s+|previous\s+|prior\s+)?(?:system|instructions?|prompt)\b/i,

  // EN — role/system markers + role flip
  /\bsystem\s+prompt\b/i,
  /\[\s*system\s*\]/i,
  /<\s*\/?\s*system\s*>/i,
  /<\s*\/?\s*assistant\s*>/i,
  /<\s*\/?\s*user\s*>/i,
  /\byou\s+are\s+now\b/i,
  /\bact\s+as\s+(?:if|a|an|the)\b/i,
  /\bpretend\s+(?:to\s+be|you\s+are)\b/i,
  /\bnew\s+instructions?\s*:/i,

  // EN — reply injection (try to force a JSON shape)
  /\b(?:reply|respond|output|answer)\s+(?:only\s+)?with\s*\{/i,
  /\b(?:reply|respond|output|answer)\s+(?:only\s+)?with\s+the\s+(?:following|json)\b/i,

  // ES — instruction override
  /\bignora\s+(?:las\s+|tus\s+|todas\s+las\s+|las\s+anteriores\s+|las\s+previas\s+)?instrucciones\b/i,
  /\bolvida\s+(?:las\s+|tus\s+|todas\s+las\s+|las\s+anteriores\s+|las\s+previas\s+)?instrucciones\b/i,
  /\bdescarta\s+(?:las\s+|tus\s+|todas\s+las\s+|las\s+anteriores\s+|las\s+previas\s+)?instrucciones\b/i,
  /\bno\s+sigas\s+(?:las\s+|tus\s+|las\s+anteriores\s+)?(?:instrucciones|reglas)\b/i,

  // ES — role/system markers + role flip
  /\bprompt\s+del?\s+sistema\b/i,
  /\bahora\s+eres\b/i,
  /\bact[uú]a\s+como\b/i,
  /\bhaz\s+de\s+cuenta\b/i,
  /\bnuevas?\s+instrucciones\s*:/i,

  // ES — reply injection
  /\bresponde\s+(?:solo\s+)?con\s*\{/i,
  /\b(?:contesta|devuelve)\s+(?:solo\s+)?con\s*\{/i,
];

/**
 * Control characters disallowed in prompt fields.
 *
 * Allow: \t (0x09), \n (0x0A), \r (0x0D), plus all printable >= 0x20.
 * Reject: NUL, BEL, ESC (terminal hijack), all other C0/C1 controls.
 *
 * Built via `new RegExp` with `\xNN` escapes inside a STRING so the
 * source file stays printable-ASCII (no raw control bytes on disk; safer
 * for editors, diffs, and CI tooling that mangles control chars).
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = new RegExp(
  '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F]',
);

export class PromptSafetyError extends Error {
  readonly fieldName: string;
  readonly reason: 'length' | 'control_char' | 'jailbreak' | 'not_string';
  readonly markerPreview?: string;

  constructor(
    fieldName: string,
    reason: 'length' | 'control_char' | 'jailbreak' | 'not_string',
    markerPreview?: string,
  ) {
    super(`prompt-safety violation in field '${fieldName}': ${reason}`);
    this.name = 'PromptSafetyError';
    this.fieldName = fieldName;
    this.reason = reason;
    this.markerPreview = markerPreview;
  }
}

/**
 * Assert a string is safe to interpolate into an LLM prompt template.
 *
 * Throws {@link PromptSafetyError} on any violation. Caller wraps the
 * full prompt-build with try/catch, emits telemetry, and skips the item.
 *
 * NOTE: Mutates nothing. Always called PER FIELD, never on the
 * concatenated prompt — we want the field-name in the error so monitoring
 * can attribute jailbreak attempts to the right input.
 */
export function assertSafeForPrompt(value: unknown, fieldName: string): void {
  if (typeof value !== 'string') {
    throw new PromptSafetyError(fieldName, 'not_string');
  }
  if (value.length > MAX_PROMPT_FIELD_LEN) {
    throw new PromptSafetyError(fieldName, 'length');
  }
  const ctrl = CONTROL_CHAR_RE.exec(value);
  if (ctrl) {
    throw new PromptSafetyError(
      fieldName,
      'control_char',
      `0x${ctrl[0].charCodeAt(0).toString(16).padStart(2, '0')}`,
    );
  }
  for (const re of JAILBREAK_PATTERNS) {
    const m = re.exec(value);
    if (m) {
      // Preview only the matched marker (NOT the surrounding field) so
      // logs stay short and do not leak more attacker text than needed.
      throw new PromptSafetyError(fieldName, 'jailbreak', m[0].slice(0, 80));
    }
  }
}

/**
 * Convenience wrapper: validate without throwing. Returns the
 * PromptSafetyError on violation, or null on clean input. Useful when the
 * caller has multiple fields and wants to log ALL violations before
 * dropping the item (e.g. monitoring "submission X had jailbreak in
 * `title` AND `summary`").
 */
export function checkSafeForPrompt(
  value: unknown,
  fieldName: string,
): PromptSafetyError | null {
  try {
    assertSafeForPrompt(value, fieldName);
    return null;
  } catch (err) {
    return err as PromptSafetyError;
  }
}
