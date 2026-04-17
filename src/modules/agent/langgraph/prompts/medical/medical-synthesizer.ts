/**
 * Medical synthesizer prompt — final step in the multi-agent pipeline.
 * Takes the researcher's structured output + the critic's review and
 * produces the refined ResearchResult the node will submit.
 *
 * The `proposal` field must be a plain-English paragraph that EMBEDS the
 * refined {discoveryType, structuredData} JSON block. The coordinator's
 * DiscoveryService.extractStructuredPayload grabs the first balanced
 * {…} block from the proposal string, so including prose around the
 * JSON keeps the proposal prose-scorable (submission-quality.ts needs
 * ≥ 100 chars / ≥ 12 words) while still carrying the structured payload.
 */

import { renderDiscoverySchemasForPrompt } from './schemas';

export interface MedicalSynthesizerParams {
  title: string;
  researcherJson: string;
  criticFeedback: string;
}

export function buildMedicalSynthesizerPrompt(p: MedicalSynthesizerParams): string {
  const schemaBlock = renderDiscoverySchemasForPrompt();

  return `You are a biomedical research synthesizer. Take the researcher's structured discovery and the peer-review critique, and produce the FINAL refined submission.

Paper: ${p.title}

Researcher's output (JSON):
${p.researcherJson}

Peer-review critique:
${p.criticFeedback}

Available discoveryType schemas (you MUST match one exactly):
${schemaBlock}

Output ONLY a JSON object with exactly this shape (no markdown, no prose outside the JSON):
{
  "summary": "<refined 2-3 sentence summary, ≥ 80 chars, addresses the critique>",
  "keyInsights": ["<refined insight, ≥ 30 chars>", "<another>", "<another>"],
  "proposal": "<prose paragraph (≥ 100 chars, ≥ 12 words) that describes the discovery in plain English, IMMEDIATELY FOLLOWED BY a machine-readable JSON block of the form {\\"discoveryType\\":\\"…\\",\\"structuredData\\":{…}} using the exact field names from the matching schema above>"
}

Rules for the proposal JSON block:
- discoveryType is one of: drug_repurposing, combination_therapy, biomarker, mechanism_link, procedure_refinement.
- structuredData must contain every required field for the chosen discoveryType.
- supporting_dois must contain ≥ 2 real DOIs (format "10.xxxx/yyyy"). NEVER invent a DOI — only use DOIs present in the researcher's output, abstract, or critique.
- If the researcher's structuredData was valid, preserve IDs unless the critique explicitly invalidates them.
- If the critique identifies a fatal flaw (missing DOIs, wrong schema, invented IDs), emit a safer discoveryType that can be fully grounded, even if it is a weaker claim.`;
}
