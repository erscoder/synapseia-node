/**
 * Node-side submission quality gate (Bug 31, 2026-05-18).
 *
 * Mirrors the coordinator's `application/work-orders/submission-quality.ts`
 * placeholder + admission rules so a pod can REJECT obviously-malformed
 * research submissions BEFORE POSTing them to /complete.
 *
 * Why duplicate? `@synapseia-network/node` is published independently from
 * the coord (decoupled-release policy 2026-05-18) and has no dependency on
 * the coord package. Sharing the file via workspace import would bloat the
 * npm bundle. We accept the duplication cost in exchange for:
 *   1. Same admission contract on both sides (P10 — comments truthful).
 *   2. Node-local saves tokens + bandwidth + a wasted evaluator review
 *      (the coord rejects malformed submissions with
 *      `[WOSubmit] reject reason=hypothesis_too_short detail=1 chars < 30 min`
 *      — verified live 2026-05-18 on wo_1779113721582_cb5db91b).
 *
 * Keep this file in lock-step with the coord's submission-quality.ts: any
 * change there must replicate here. Tests in
 * `__tests__/node-side-submission-quality.spec.ts` pin the same fixtures
 * the coord tests use so drift is caught at CI.
 *
 * Reviewer-lesson P26 — every input field that flows toward an external
 * consumer must pass through the SAME validator set, not just the
 * "nominally untrusted" one. Here `summary`, `proposal`, AND every
 * keyInsight go through `isPlaceholder` + error-marker checks.
 */

/**
 * Patterns that indicate the LLM emitted a template placeholder instead of
 * real content. Mirrors coord's PLACEHOLDER_PATTERNS exactly (2026-05-18).
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^<[^>]{3,}>$/,                   // pure angle-bracket placeholder: <summary here>
  /^REAL .{3,} here$/i,             // prompt artifact: "REAL summary here"
  /^<[0-9]+-[0-9]+ sentences/i,     // <3-4 sentences: ...>
  /^<concrete application/i,        // <concrete application proposal...>
  /^<[a-z ]{5,}>$/i,                // any short angle-bracket description
  /^\[.*placeholder.*\]$/i,         // [placeholder text]
  /^see summary(?: for details)?$/i,
  /^no proposal generated$/i,
  /^no summary generated$/i,        // matches synthesizer-node legacy fallback string
  /^\[object object\]$/i,
  /^research completed$/i,
  /^analysis of /i,                 // "Analysis of <title>" execute-research fallback
];

export function isNodeSidePlaceholder(s: string): boolean {
  const t = s.trim();
  return PLACEHOLDER_PATTERNS.some(p => p.test(t));
}

/**
 * Coord's `[WOSubmit] reject reason=hypothesis_too_short detail=N chars < 30 min`
 * uses 30 as the lower bound on hypothesis length. We mirror that exact
 * threshold so the local gate triggers on the same payloads the coord
 * would reject — no over-zealous local filtering that drops valid
 * submissions.
 */
export const COORD_HYPOTHESIS_MIN_CHARS = 30;

export interface QualityGateResult {
  /** true if the payload would be admitted by the coord */
  ok: boolean;
  /** machine-readable reason when ok=false (matches coord log strings where possible) */
  reason?:
    | 'hypothesis_too_short'
    | 'placeholder_or_error'
    | 'empty_payload';
  /** human-readable detail for the warn log */
  detail?: string;
}

/**
 * Validate a research-WO submission payload against the coord's admission
 * contract. Returns `ok: true` if the coord would accept it.
 *
 * Inputs:
 *   - `summary` (also accepted under `hypothesis` field)
 *   - `proposal` (also accepted under `proof`)
 *   - `keyInsights[]`
 *
 * Reject reasons:
 *   - empty payload (all three fields empty/missing)
 *   - any text field contains an error marker (`Error:`, `<!DOCTYPE`,
 *     `is not valid JSON`) or matches a placeholder pattern
 *   - hypothesis < COORD_HYPOTHESIS_MIN_CHARS (matches coord's
 *     `hypothesis_too_short` reject)
 *
 * The coord's `passesQualityGate` admits if ANY of:
 *   - hypothesis >= 80 chars + 10 words
 *   - >=3 valid keyInsights of >= 20 chars
 *   - proposal >= 100 chars + 12 words
 * but the visible reject in pod logs is `hypothesis_too_short detail=N < 30`,
 * so we keep the LOW bar locally (30 chars) and let the coord's stricter
 * `passesQualityGate` decide admission. The point of the local gate is to
 * cheaply catch the 1-char-summary class of failures, not to reproduce
 * every coord rule.
 */
export function validateResearchPayload(payload: Record<string, unknown>): QualityGateResult {
  const hypothesis =
    typeof payload.hypothesis === 'string' ? payload.hypothesis.trim()
    : typeof payload.summary   === 'string' ? payload.summary.trim()
    : '';
  const proposal =
    typeof payload.proposal === 'string' ? payload.proposal.trim()
    : typeof payload.proof  === 'string' ? payload.proof.trim()
    : '';
  const insights: string[] = Array.isArray(payload.keyInsights)
    ? (payload.keyInsights as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim())
    : [];

  if (!hypothesis && !proposal && insights.length === 0) {
    return { ok: false, reason: 'empty_payload', detail: 'all fields empty' };
  }

  for (const s of [hypothesis, proposal, ...insights]) {
    if (
      s.includes('Error:') ||
      s.includes('<!DOCTYPE') ||
      s.includes('is not valid JSON') ||
      isNodeSidePlaceholder(s)
    ) {
      return {
        ok: false,
        reason: 'placeholder_or_error',
        detail: `placeholder/error marker in field: "${s.slice(0, 60)}"`,
      };
    }
  }

  if (hypothesis.length < COORD_HYPOTHESIS_MIN_CHARS) {
    return {
      ok: false,
      reason: 'hypothesis_too_short',
      detail: `${hypothesis.length} chars < ${COORD_HYPOTHESIS_MIN_CHARS} min`,
    };
  }

  return { ok: true };
}

/**
 * Convenience: validate the JSON-encoded result string that
 * SubmitResultNode is about to POST. Returns `ok: false` if the string is
 * not parseable as JSON OR fails the research payload contract.
 *
 * Non-research WO types (TRAINING, DOCKING, INFERENCE) ship binary-shape
 * results that do not match `{summary, proposal, keyInsights}`; the caller
 * is responsible for skipping this gate on those types. We DO NOT block
 * on a missing field for non-research shapes — checked by the caller.
 */
export function validateResearchResultJsonString(rawJson: string): QualityGateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      ok: false,
      reason: 'empty_payload',
      detail: 'result is not parseable JSON',
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: 'empty_payload',
      detail: 'result is not an object',
    };
  }
  return validateResearchPayload(parsed as Record<string, unknown>);
}
