/**
 * Medical researcher prompt — first step in the multi-agent pipeline.
 *
 * Instructs the LLM to emit a structured biomedical discovery payload
 * matching one of the 5 DiscoveryType schemas. The node will embed this
 * payload in the `proposal` field of the submission; the coordinator's
 * DiscoveryService.extractStructuredPayload parses it out with a regex
 * looking for the first balanced {…} block.
 *
 * 2026-04-26 audit revealed three failure modes in production: the LLM
 * was emitting wrong field names (`"RxNorm"` instead of `drug_rxnorm_id`),
 * inventing IDs with implausible prefixes (`"R03945"` instead of `7933`),
 * and pasting multiple JSON objects together (`}}, {`). Schema-only
 * descriptions weren't enough — small models (Llama-class via Ollama)
 * need explicit anti-patterns and at least one worked example to mirror.
 */

import { renderDiscoverySchemasForPrompt } from './schemas';

export interface MedicalResearcherParams {
  title: string;
  abstract: string;
  doi?: string;
  kgContext?: string;
  referenceContext?: string;
  /** DOIs drawn from the coordinator corpus for the same topic; safe to cite as supporting_dois. */
  relatedDois?: string[];
  /**
   * Pre-rendered mission context block (from mission-context-state.
   * renderMissionBriefForPrompt). Empty string disables the section.
   * Audit 2026-04-25 (C1): grounding the LLM in the active goals stops
   * the network from generating heart-transplant papers for ALS missions.
   */
  missionContext?: string;
}

/**
 * Step 3 (2026-04-30) — long titles (observed up to 280 chars on Chinese
 * oncology papers) inflate the prompt past the budget the small models
 * can plan over. Truncate the prompt-time title to 120 chars; the full
 * title remains in the work-order record for downstream consumers.
 */
const PROMPT_TITLE_MAX_CHARS = 120;
function truncateTitleForPrompt(title: string): string {
  if (!title || title.length <= PROMPT_TITLE_MAX_CHARS) return title;
  return `${title.slice(0, PROMPT_TITLE_MAX_CHARS - 1)}…`;
}

export function buildMedicalResearcherPrompt(p: MedicalResearcherParams): string {
  const schemaBlock = renderDiscoverySchemasForPrompt();

  const title = truncateTitleForPrompt(p.title);
  const doiLine = p.doi ? `\nDOI of this paper: ${p.doi}` : '';
  const kg = p.kgContext ? `\n\nKnowledge-graph context:\n${p.kgContext}` : '';
  const ref = p.referenceContext ? `\n\nReference corpus context:\n${p.referenceContext}` : '';
  const related = p.relatedDois?.length
    ? `\n\nRelated paper DOIs (draw supporting_dois from this list plus the source paper):\n${p.relatedDois.map((d) => `  - ${d}`).join('\n')}`
    : '';
  const mission = p.missionContext && p.missionContext.length > 0
    ? `\n\n${p.missionContext}\n\nIf the paper genuinely supports an active mission, foreground that connection in your summary and pick the discoveryType that best advances the mission. If none of the active missions apply, still emit a discovery — but note in the summary that the paper is off-mission.`
    : '';

  return `You are a biomedical research analyst. Read the paper and propose exactly ONE structured discovery.${mission}

Paper: ${title}
Abstract: ${p.abstract}${doiLine}${kg}${ref}${related}

Pick the ONE discoveryType that best fits the paper's main claim:
${schemaBlock}

Output ONLY a JSON object with exactly this shape (no markdown, no prose, no \`\`\`):
{
  "summary": "<2-3 sentence plain-text summary, ≥ 80 chars, not paraphrasing the abstract>",
  "keyInsights": ["<non-obvious finding, ≥ 30 chars>", "<another>", "<another>"],
  "discoveryType": "<one of: drug_repurposing | combination_therapy | biomarker | mechanism_link | procedure_refinement>",
  "structuredData": { <the required fields for the chosen discoveryType, copied from the schema above> }
}

═══ WORKED EXAMPLE — copy this shape exactly ═══

For a paper titled "Riluzole prolongs survival in patients with amyotrophic lateral sclerosis"
(DOI 10.1056/NEJM199403033300901), a correct output is:

{
  "summary": "Riluzole, a benzothiazole sodium-channel blocker, extends median survival by ~3 months in ALS patients in a placebo-controlled trial of 155 participants. The mechanism is presumed glutamate antagonism reducing motor-neuron excitotoxicity. The effect is modest but reproducible across follow-up cohorts.",
  "keyInsights": [
    "Sodium-channel blockade reduces glutamate-driven motor-neuron death in ALS",
    "Median survival gain ~3 months vs placebo at 18-month follow-up",
    "Effect size is similar in bulbar and limb-onset subgroups"
  ],
  "discoveryType": "drug_repurposing",
  "structuredData": {
    "drug_rxnorm_id": "9325",
    "disease_mesh_id": "D000690",
    "mechanism_summary": "Riluzole inhibits voltage-gated sodium channels and presynaptic glutamate release, reducing excitotoxic injury in spinal and bulbar motor neurons.",
    "supporting_dois": ["10.1056/NEJM199403033300901", "10.1016/S0140-6736(96)91680-3"],
    "novel_contribution": "Riluzole at 50mg twice daily extends median survival in definite or probable amyotrophic lateral sclerosis by approximately three months versus placebo across a 155-patient double-blind trial, with consistent benefit in bulbar and limb-onset subgroups via glutamate antagonism on motor neurons.",
    "evidence_type": "literature_review"
  }
}

Note: \`drug_rxnorm_id\`, \`disease_mesh_id\`, \`mechanism_summary\`, \`supporting_dois\` — those exact field names. RxNorm RXCUI \`9325\` and MeSH \`D000690\` are real, grounded identifiers.

═══ ANTI-PATTERNS — these outputs are INVALID and will be rejected ═══

❌ WRONG keys: \`"RxNorm": [...]\`, \`"MeSH": [...]\`, \`"UMLS CUI": [...]\` — these are NOT in the schema. Use \`drug_rxnorm_id\` (singular), \`disease_mesh_id\`, \`umls_cui\` exactly as the schema spells them.

❌ WRONG IDs: RxNorm RXCUIs are NUMERIC strings (e.g. \`"7933"\`, \`"9325"\`). Never invent prefixes like \`"R03945"\` or \`"RX-12345"\`. MeSH descriptor IDs start with the letter D followed by 6 digits (\`"D000690"\`); they are NOT free-text disease names like \`"Heart failure"\`. UMLS CUIs are uppercase C followed by 7 digits (\`"C0002736"\`).

❌ MULTIPLE OBJECTS: Output ONE single JSON object. Never paste two objects together as \`{...}}, {...}\` — that is invalid output and the parser will reject the whole submission.

❌ PROSE OUTSIDE JSON: No markdown, no \`\`\`json fences, no explanation before or after. Just the JSON.

❌ INVENTED DOIs: Every DOI in \`supporting_dois\` must literally appear in the abstract, the source paper's DOI, or the related-paper DOIs above. If you cannot find ≥2 grounded DOIs, switch to \`mechanism_link\` (the schema variant with the laxest evidence requirement) — never invent.

═══ STRICT RULES ═══

- supporting_dois must contain ≥ 2 real DOIs drawn from the abstract, the source paper's DOI, or the related-paper DOIs listed above. NEVER invent a DOI.
- All ID fields (RxNorm, MeSH, UMLS CUI) must be real identifiers you can cite from the abstract or context. If you cannot ground an ID, pick a different discoveryType that does not require it.
- summary and keyInsights must be plain English, not JSON.
- Do NOT include a "proposal" field — the proposal is built downstream from structuredData.
- Use the EXACT field names from the schema block above. \`drug_rxnorm_id\` not \`"RxNorm"\`. \`disease_mesh_id\` not \`"MeSH"\`. \`umls_cui\` not \`"UMLS CUI"\`.
- structuredData MUST include \`novel_contribution\` (≥ 80 chars, ≥ 15 distinct non-stopword tokens, references the drug/disease/pathway/biomarker terms above) and \`evidence_type\` (one of literature_review | meta_analysis | gap_analysis | hypothesis_generation | contradiction_detected). meta_analysis requires ≥ 3 distinct supporting_dois; contradiction_detected requires novel_contribution to use a conflict word (contradict / disagree / conflict / inconsist / oppose).

❌ DO NOT confuse \`discoveryType\` (the structural class of the finding —
one of drug_repurposing | combination_therapy | biomarker | mechanism_link |
procedure_refinement) with \`evidence_type\` (the methodological class of the
underlying study — one of literature_review | meta_analysis | gap_analysis |
hypothesis_generation | contradiction_detected). They are TWO independent
fields. \`gap_analysis\`, \`hypothesis_generation\`, \`literature_review\`,
\`meta_analysis\`, and \`contradiction_detected\` are NEVER discoveryTypes —
only valid \`evidence_type\` values inside \`structuredData\`. The coordinator
rejects submissions like \`"discoveryType":"gap_analysis"\` with
\`Unknown discoveryType: gap_analysis\`.`;
}
