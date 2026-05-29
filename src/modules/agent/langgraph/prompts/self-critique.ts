/**
 * Self-critique prompt template for research quality assessment
 * Sprint B - LLM reviews its own output
 *
 * UNWIRED LEGACY BUILDER (P26, audit L1321): `buildSelfCritiquePrompt` has NO
 * production caller. It is kept as a documented option. To stay safe by default
 * for any future re-wiring, every field interpolated into the prompt is routed
 * through `sanitizeForPrompt` here (the analysis fields are LLM-generated from
 * peer-supplied paper text, so they are untrusted): jailbreak markers
 * hard-reject, control chars stripped, over-long fields truncated. Do NOT
 * re-wire this without keeping that gate.
 */

import { sanitizeForPrompt } from '../../../../shared/prompt-safety';

export interface SelfCritiquePromptParams {
  title: string;
  summary: string;
  keyInsights: string;
  proposal: string;
}

/**
 * Build the self-critique prompt for the LLM
 */
export function buildSelfCritiquePrompt(params: SelfCritiquePromptParams): string {
  // P26: gate every interpolated field before it reaches the prompt.
  const safeTitle = sanitizeForPrompt(params.title, 'params.title');
  const safeSummary = sanitizeForPrompt(params.summary, 'params.summary');
  const safeKeyInsights = sanitizeForPrompt(params.keyInsights, 'params.keyInsights');
  const safeProposal = sanitizeForPrompt(params.proposal, 'params.proposal');

  return `You are reviewing your own research analysis. Score it honestly.

Title: ${safeTitle}
Your analysis:
- Summary: ${safeSummary}
- Key insights: ${safeKeyInsights}
- Proposal: ${safeProposal}

Score each dimension 0-10:
- accuracy: Are claims factually supported by the abstract?
- completeness: Are all major findings covered?
- novelty: Are insights non-obvious (not just paraphrasing)?
- actionability: Is the proposal concrete and specific?

Output ONLY a JSON object (no markdown, no extra text):
{"accuracy":<0-10>,"completeness":<0-10>,"novelty":<0-10>,"actionability":<0-10>,"feedback":"<one sentence>","passed":<true|false>}`;
}

/**
 * Interface for the self-critique response from LLM
 */
export interface SelfCritiqueResponse {
  accuracy: number;
  completeness: number;
  novelty: number;
  actionability: number;
  feedback: string;
  passed: boolean;
}

/**
 * Parse and validate the self-critique response.
 *
 * generateJSON ensures the LLM emits syntactically valid JSON, so this
 * function only needs to validate the schema and clamp numeric values.
 *
 * Outcomes:
 *  1. Valid JSON + all 4 scores → use them (pass/fail by computed avg ≥ 7.0)
 *  2. Valid JSON but missing fields → fail + retry (LLM didn't follow schema)
 *  3. JSON.parse fails (provider without JSON mode) → fail + retry
 */
export function parseSelfCritiqueResponse(jsonText: string): SelfCritiqueResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    return {
      accuracy: 0, completeness: 0, novelty: 0, actionability: 0,
      feedback: 'Failed to parse critique response - needs improvement',
      passed: false,
    };
  }

  if (
    typeof parsed.accuracy !== 'number' ||
    typeof parsed.completeness !== 'number' ||
    typeof parsed.novelty !== 'number' ||
    typeof parsed.actionability !== 'number'
  ) {
    return {
      accuracy: 0, completeness: 0, novelty: 0, actionability: 0,
      feedback: 'Incomplete critique response — missing required score fields',
      passed: false,
    };
  }

  const clamp = (n: number) => Math.max(0, Math.min(10, n));
  const a = clamp(parsed.accuracy);
  const c = clamp(parsed.completeness);
  const n = clamp(parsed.novelty);
  const ac = clamp(parsed.actionability);

  return {
    accuracy: a, completeness: c, novelty: n, actionability: ac,
    feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
    passed: (a + c + n + ac) / 4 >= 7.0,
  };
}

/**
 * Calculate average score from critique dimensions
 */
export function calculateAverageScore(critique: SelfCritiqueResponse): number {
  return (critique.accuracy + critique.completeness + critique.novelty + critique.actionability) / 4;
}
