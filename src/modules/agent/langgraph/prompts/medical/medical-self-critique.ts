/**
 * Medical self-critique prompt (M3.3).
 *
 * Extends the generic self-critique with a fifth dimension —
 * `ontologyGrounding` — that scores whether the discovery's IDs
 * (RxNorm, MeSH, UMLS CUI) and supporting DOIs are real and come from
 * the abstract/context, or whether the LLM invented them.
 *
 * Same schema otherwise: scores 0-10, overall pass at avg ≥ 7.0. The
 * prompt tells the model to grade grounding harshly — a single made-up
 * DOI should drop the dimension below 5.
 */

import type { SelfCritiquePromptParams, SelfCritiqueResponse } from '../self-critique';

export interface MedicalSelfCritiquePromptParams extends SelfCritiquePromptParams {
  /** The proposal string as submitted. Usually carries the {discoveryType, structuredData} JSON block. */
  proposal: string;
  /** Abstract + context the researcher had available — used so the critic can cross-check DOIs. */
  groundingSources?: string;
}

export interface MedicalSelfCritiqueResponse extends SelfCritiqueResponse {
  /** 0-10 score for whether IDs and DOIs are grounded in the source, not invented. */
  ontologyGrounding: number;
}

export function buildMedicalSelfCritiquePrompt(p: MedicalSelfCritiquePromptParams): string {
  const grounding = p.groundingSources
    ? `\n\nGrounding sources available to the researcher:\n${p.groundingSources}`
    : '';

  return `You are reviewing your own biomedical research analysis. Score honestly.

Title: ${p.title}

Your analysis:
- Summary: ${p.summary}
- Key insights: ${p.keyInsights}
- Proposal (may contain an embedded {discoveryType, structuredData} JSON block): ${p.proposal}${grounding}

Score each dimension 0-10:
- accuracy: Are claims factually supported by the abstract?
- completeness: Are all major findings covered?
- novelty: Are insights non-obvious (not just paraphrasing)?
- actionability: Is the proposal concrete and specific?
- ontologyGrounding: Are the structured IDs real and grounded? Grade harshly.
  • drug_rxnorm_id / drugs_rxnorm_ids must be real RxNorm RXCUIs (6-7 digits).
  • disease_mesh_id / disease_mesh_ids must be real MeSH descriptor IDs (e.g. "D000690").
  • umls_cui must be a real UMLS CUI (e.g. "C0002736"), not a guess.
  • supporting_dois MUST all appear in the abstract or grounding sources above.
    Any DOI not present there → this dimension ≤ 3. Zero DOIs that check out → score 0.

Output ONLY a JSON object (no markdown, no extra text):
{"accuracy":<0-10>,"completeness":<0-10>,"novelty":<0-10>,"actionability":<0-10>,"ontologyGrounding":<0-10>,"feedback":"<one sentence, cite the weakest dimension>","passed":<true|false>}

\`passed\` should be true only when the five-dimension average is ≥ 7.0 AND ontologyGrounding is ≥ 6.
A single invented DOI or fabricated ID should fail the whole critique.`;
}

/**
 * Parse + clamp the medical self-critique response. Falls back to the
 * safe shape (all zeros, passed=false) on JSON parse errors — same
 * contract as the generic parseSelfCritiqueResponse.
 */
export function parseMedicalSelfCritiqueResponse(raw: string): MedicalSelfCritiqueResponse {
  const FAIL: MedicalSelfCritiqueResponse = {
    accuracy: 0,
    completeness: 0,
    novelty: 0,
    actionability: 0,
    ontologyGrounding: 0,
    feedback: 'Failed to parse medical critique response',
    passed: false,
  };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    return FAIL;
  }

  const fields: Array<'accuracy' | 'completeness' | 'novelty' | 'actionability' | 'ontologyGrounding'> = [
    'accuracy', 'completeness', 'novelty', 'actionability', 'ontologyGrounding',
  ];

  for (const f of fields) {
    if (typeof parsed[f] !== 'number') {
      return { ...FAIL, feedback: `Incomplete critique — missing "${f}"` };
    }
  }

  const clamp = (n: number): number => Math.max(0, Math.min(10, n));
  const a = clamp(parsed.accuracy as number);
  const c = clamp(parsed.completeness as number);
  const n = clamp(parsed.novelty as number);
  const ac = clamp(parsed.actionability as number);
  const og = clamp(parsed.ontologyGrounding as number);

  // Pass if 5-dim avg ≥ 7.0 AND grounding ≥ 6.
  const avg = (a + c + n + ac + og) / 5;
  const passed = avg >= 7.0 && og >= 6;

  return {
    accuracy: a,
    completeness: c,
    novelty: n,
    actionability: ac,
    ontologyGrounding: og,
    feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
    passed,
  };
}

export function calculateMedicalAverageScore(critique: MedicalSelfCritiqueResponse): number {
  return (
    critique.accuracy
    + critique.completeness
    + critique.novelty
    + critique.actionability
    + critique.ontologyGrounding
  ) / 5;
}
