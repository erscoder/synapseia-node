/**
 * Medical self-critique prompt (M3.3).
 *
 * Extends the generic self-critique with a fifth dimension —
 * `ontologyGrounding` — that scores whether the discovery's IDs
 * (RxNorm, MeSH, UMLS CUI) and supporting DOIs are real and come from
 * the abstract/context, or whether the LLM invented them.
 *
 * 2026-04-26 audit: the previous threshold (avg ≥ 7.0 AND grounding ≥ 6)
 * was passing payloads that had wrong schema keys (`"RxNorm"` instead of
 * `drug_rxnorm_id`) and invented IDs (`"R03945"`). Tightened: grounding
 * floor raised to 8 and an explicit rule says "wrong schema keys → set
 * ontologyGrounding=0 and passed=false unconditionally."
 *
 * 2026-05-05 tier (option 2): the og=8 floor was too aggressive for
 * discoveryTypes / evidence_types that legitimately do not require
 * RxNorm/MeSH/UMLS IDs:
 *   - `mechanism_link` is keyed on pathway_name + mesh, drug ID is optional.
 *   - `evidence_type` ∈ {literature_review, gap_analysis,
 *     hypothesis_generation} surveys / open questions, often source from
 *     review papers without ground-level IDs.
 * The wrong-schema-key risk that the 2026-04-26 raise guarded against
 * is now handled upstream by the universal-field validator
 * (`extractStructuredPayloadFromProposal` + `validateDiscoverySchema` in
 * synthesizer-node). So the parser drops the og floor to a tier:
 *   - ID-bearing types (drug_repurposing, combination_therapy, biomarker,
 *     procedure_refinement) on ID-bearing evidence → og ≥ 7
 *   - mechanism_link OR review/gap/hypothesis evidence_type → og ≥ 5
 *   - unknown context (parser called without context) → og ≥ 7 (safe default)
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
  • The proposal's JSON block MUST use the exact schema field names:
    \`drug_rxnorm_id\`, \`drugs_rxnorm_ids\`, \`disease_mesh_id\`, \`disease_mesh_ids\`,
    \`umls_cui\`, \`pathway_name\`, \`mechanism_summary\`, \`supporting_dois\`,
    \`biomarker_name\`, \`base_procedure_umls\`, \`modification\`, \`synergy_evidence\`.
    If you see ANY of \`"RxNorm"\`, \`"MeSH"\`, \`"UMLS CUI"\`, \`"DOI"\` (capitalized,
    non-snake-case, or otherwise not in the list above) → set ontologyGrounding=0
    and passed=false. No exceptions.
  • drug_rxnorm_id / drugs_rxnorm_ids must be NUMERIC RxNorm RXCUIs (e.g. "7933").
    Identifiers with letter prefixes like "R03945" or "RX-…" are invented → set
    ontologyGrounding=0.
  • disease_mesh_id / disease_mesh_ids must be MeSH descriptor IDs of the form
    "D" + 6 digits (e.g. "D000690"). Free-text disease names like "Heart failure"
    are NOT IDs → set ontologyGrounding=0.
  • umls_cui must be of the form "C" + 7 digits (e.g. "C0002736"). Anything else
    → set ontologyGrounding ≤ 2.
  • supporting_dois MUST all appear in the abstract or grounding sources above.
    Any DOI not present there → this dimension ≤ 3. Zero DOIs that check out → score 0.
  • Multiple JSON objects pasted together inside the proposal (\`}}, {\`) → set
    ontologyGrounding=0 and passed=false.

Output ONLY a JSON object (no markdown, no extra text):
{"accuracy":<0-10>,"completeness":<0-10>,"novelty":<0-10>,"actionability":<0-10>,"ontologyGrounding":<0-10>,"feedback":"<one sentence, cite the weakest dimension>","passed":<true|false>}

\`passed\` should be true only when the five-dimension average is ≥ 7.0 AND ontologyGrounding clears the tier floor:
  • discoveryType in {drug_repurposing, combination_therapy, biomarker, procedure_refinement}
    AND evidence_type NOT in {literature_review, gap_analysis, hypothesis_generation} → og ≥ 7
  • discoveryType=mechanism_link OR evidence_type in {literature_review, gap_analysis, hypothesis_generation} → og ≥ 5
A single invented DOI, fabricated ID, wrong schema key, or multi-object paste fails the whole critique.`;
}

/**
 * Context for the tiered ontologyGrounding floor (2026-05-05). When the
 * caller can extract `discoveryType` + `evidence_type` from the proposal
 * payload, pass them in so the parser applies the right floor. Without
 * context the parser falls back to the safe og ≥ 7 default.
 */
export interface MedicalSelfCritiqueContext {
  discoveryType?: string;
  evidenceType?: string;
}

/** Discovery types that do NOT require ground-level RxNorm/MeSH/UMLS IDs. */
const RELAXED_DISCOVERY_TYPES = new Set(['mechanism_link']);

/** Evidence types that legitimately come from surveys / open questions. */
const RELAXED_EVIDENCE_TYPES = new Set([
  'literature_review',
  'gap_analysis',
  'hypothesis_generation',
]);

/**
 * Resolve the ontologyGrounding floor from optional context. ID-bearing
 * discoveries on direct evidence keep the strict floor (≥ 7); relaxed
 * types or review/gap/hypothesis evidence drop to ≥ 5.
 */
function resolveOntologyGroundingFloor(ctx?: MedicalSelfCritiqueContext): number {
  if (!ctx) return 7;
  if (ctx.discoveryType && RELAXED_DISCOVERY_TYPES.has(ctx.discoveryType)) return 5;
  if (ctx.evidenceType && RELAXED_EVIDENCE_TYPES.has(ctx.evidenceType)) return 5;
  return 7;
}

/**
 * Parse + clamp the medical self-critique response. Falls back to the
 * safe shape (all zeros, passed=false) on JSON parse errors — same
 * contract as the generic parseSelfCritiqueResponse.
 *
 * @param raw     Raw LLM JSON response.
 * @param context Optional discoveryType + evidence_type for tiered og floor.
 */
export function parseMedicalSelfCritiqueResponse(
  raw: string,
  context?: MedicalSelfCritiqueContext,
): MedicalSelfCritiqueResponse {
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

  // Pass if 5-dim avg ≥ 7.0 AND grounding clears the tier floor. The
  // floor is 7 by default and drops to 5 for mechanism_link / review-type
  // evidence (see resolveOntologyGroundingFloor). The 2026-04-26 og=8
  // raise guarded against wrong-schema-key payloads slipping through;
  // that risk is now caught upstream by the universal-field validator
  // in synthesizer-node, so the floor here can be relaxed.
  const avg = (a + c + n + ac + og) / 5;
  const ogFloor = resolveOntologyGroundingFloor(context);
  const passed = avg >= 7.0 && og >= ogFloor;

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
