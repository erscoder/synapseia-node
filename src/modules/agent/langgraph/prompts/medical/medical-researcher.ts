/**
 * Medical researcher prompt — first step in the multi-agent pipeline.
 *
 * Instructs the LLM to emit a structured biomedical discovery payload
 * matching one of the 5 DiscoveryType schemas. The node will embed this
 * payload in the `proposal` field of the submission; the coordinator's
 * DiscoveryService.extractStructuredPayload parses it out with a regex
 * looking for the first balanced {…} block.
 *
 * When the abstract doesn't cleanly match any of the 5 types, the LLM is
 * told to pick the closest and keep supporting_dois grounded in the
 * abstract / context DOIs — never invent DOIs.
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
}

export function buildMedicalResearcherPrompt(p: MedicalResearcherParams): string {
  const schemaBlock = renderDiscoverySchemasForPrompt();

  const doiLine = p.doi ? `\nDOI of this paper: ${p.doi}` : '';
  const kg = p.kgContext ? `\n\nKnowledge-graph context:\n${p.kgContext}` : '';
  const ref = p.referenceContext ? `\n\nReference corpus context:\n${p.referenceContext}` : '';
  const related = p.relatedDois?.length
    ? `\n\nRelated paper DOIs (draw supporting_dois from this list plus the source paper):\n${p.relatedDois.map((d) => `  - ${d}`).join('\n')}`
    : '';

  return `You are a biomedical research analyst. Read the paper and propose exactly ONE structured discovery.

Paper: ${p.title}
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

Strict rules:
- supporting_dois must contain ≥ 2 real DOIs drawn from the abstract, the source paper's DOI, or the related-paper DOIs listed above. NEVER invent a DOI.
- All ID fields (RxNorm, MeSH, UMLS CUI) must be real identifiers you can cite from the abstract or context. If you cannot ground an ID, pick a different discoveryType that does not require it.
- summary and keyInsights must be plain English, not JSON.
- Do NOT include a "proposal" field — the proposal is built downstream from structuredData.`;
}
