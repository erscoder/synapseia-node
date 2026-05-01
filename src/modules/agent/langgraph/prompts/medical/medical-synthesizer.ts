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
 *
 * 2026-04-26 audit: synthesizer outputs were the worst offenders for the
 * multi-object-paste failure mode — the LLM pasted 2-4 JSON objects
 * inside the `proposal` string. Hardened with explicit single-object
 * guards, a worked example, and an anti-pattern list.
 */

import { renderDiscoverySchemasForPrompt } from './schemas';

export interface MedicalSynthesizerParams {
  title: string;
  researcherJson: string;
  criticFeedback: string;
}

/**
 * Step 3 (2026-04-30) — long titles (observed up to 280 chars on Chinese
 * oncology papers) consume so much of the prompt budget that small models
 * regress to prose-only output and fail buildResearchResult. Truncate the
 * prompt-time title to 120 chars; the full title remains in `payload.title`
 * for the WO record.
 */
const PROMPT_TITLE_MAX_CHARS = 120;
function truncateTitleForPrompt(title: string): string {
  if (!title || title.length <= PROMPT_TITLE_MAX_CHARS) return title;
  return `${title.slice(0, PROMPT_TITLE_MAX_CHARS - 1)}…`;
}

export function buildMedicalSynthesizerPrompt(p: MedicalSynthesizerParams): string {
  const schemaBlock = renderDiscoverySchemasForPrompt();
  const title = truncateTitleForPrompt(p.title);

  return `You are a biomedical research synthesizer. Take the researcher's structured discovery and the peer-review critique, and produce the FINAL refined submission.

Paper: ${title}

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

═══ WORKED EXAMPLE — for a riluzole/ALS paper, the correct output is ═══

{
  "summary": "Riluzole extends ALS survival ~3 months via glutamate antagonism, reproducible across cohorts. Critique requested clearer mechanism wording — addressed.",
  "keyInsights": [
    "Sodium-channel blockade dampens excitotoxic motor-neuron death",
    "Median survival gain ~3 months at 18 months follow-up",
    "Effect is consistent across bulbar and limb-onset subgroups"
  ],
  "proposal": "This work supports repurposing riluzole, a benzothiazole sodium-channel blocker originally evaluated for anticonvulsant use, as a disease-modifying therapy for amyotrophic lateral sclerosis. The drug reduces presynaptic glutamate release and lowers excitotoxic injury to motor neurons, yielding modest but reproducible survival gains. {\\"discoveryType\\":\\"drug_repurposing\\",\\"structuredData\\":{\\"drug_rxnorm_id\\":\\"9325\\",\\"disease_mesh_id\\":\\"D000690\\",\\"mechanism_summary\\":\\"Riluzole inhibits voltage-gated sodium channels and presynaptic glutamate release, reducing excitotoxic injury to motor neurons.\\",\\"supporting_dois\\":[\\"10.1056/NEJM199403033300901\\",\\"10.1016/S0140-6736(96)91680-3\\"]}}"
}

Note three things in the proposal field:
1. Prose first, then ONE embedded JSON block, then nothing.
2. Field names match the schema EXACTLY (\`drug_rxnorm_id\`, not \`"RxNorm"\`).
3. RXCUI \`9325\` is a real RxNorm identifier; MeSH \`D000690\` is real; the DOIs are real.

═══ ANTI-PATTERNS — these will fail the coordinator's parser ═══

❌ MULTIPLE OBJECTS in the proposal: \`"proposal": "...{...},{...}..."\`. Output exactly ONE \`{discoveryType, structuredData}\` block per submission. If the paper supports two ideas, pick the strongest and discard the other.

❌ WRONG keys inside structuredData: \`"RxNorm"\`, \`"MeSH"\`, \`"UMLS CUI"\` are NOT schema fields. Use \`drug_rxnorm_id\` / \`disease_mesh_id\` / \`umls_cui\` (singular, snake_case, exactly as in the schema).

❌ INVENTED IDs: RxNorm RXCUIs are numeric strings (\`"7933"\`, \`"9325"\`); never \`"R03945"\` or \`"RX-…"\`. MeSH IDs are \`D\` + 6 digits (\`"D000690"\`); never free text. UMLS CUIs are \`C\` + 7 digits.

❌ DOI HALLUCINATIONS: Every DOI must come from the researcher's output, the abstract, or the critique — never invent. If <2 valid DOIs available, switch to \`mechanism_link\` (laxest evidence) before fabricating.

❌ MARKDOWN: No \`\`\`json fences, no headings, no leading/trailing prose outside the JSON object.

═══ RULES FOR THE PROPOSAL JSON BLOCK ═══

- discoveryType is one of: drug_repurposing, combination_therapy, biomarker, mechanism_link, procedure_refinement.
- structuredData must contain every required field for the chosen discoveryType.
- supporting_dois must contain ≥ 2 real DOIs (format "10.xxxx/yyyy"). NEVER invent a DOI — only use DOIs present in the researcher's output, abstract, or critique.
- If the researcher's structuredData was valid, preserve IDs unless the critique explicitly invalidates them.
- If the critique identifies a fatal flaw (missing DOIs, wrong schema, invented IDs), emit a safer discoveryType that can be fully grounded, even if it is a weaker claim.
- Use the EXACT schema field names. The coordinator strictly validates them and silently drops payloads with wrong keys.`;
}
