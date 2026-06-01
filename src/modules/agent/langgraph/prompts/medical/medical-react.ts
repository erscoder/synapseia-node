/**
 * Medical variant of the ReAct prompt (single-agent path in
 * execute-research.ts). Steers the same tool-calling loop toward a
 * structured biomedical discovery payload.
 */

import { renderDiscoverySchemasForPrompt } from './schemas';
import { sanitizeForPrompt } from '../../../../../shared/prompt-safety';

export interface MedicalReActParams {
  wo: { title: string; abstract: string; doi?: string };
  plan: string[];
  availableTools: string;
  observations: Array<{ tool: string; result: string }>;
  relatedDois?: string[];
}

export function buildMedicalReActPrompt(p: MedicalReActParams): string {
  // P26 prompt-safety gate (F-node-004). WO title/abstract come from the
  // coordinator and may have been authored by an untrusted submitter;
  // observations carry tool output that frequently includes peer-supplied
  // text (search_corpus snippets, fetched abstracts). Run each interpolated
  // field through sanitizeForPrompt: jailbreak markers are HARD-rejected
  // (throws PromptSafetyError) while length is TRUNCATED in place. We must
  // NOT throw on mere length here — a throw makes execute-research fall back
  // to the legacy executor whose prompt builders interpolate the SAME
  // untrusted text, and which (pre-fix) did so unguarded (the truncation
  // attack was a bypass primitive). Use the sanitized return values below.
  const safeTitle = sanitizeForPrompt(p.wo.title, 'wo.title');
  const safeAbstract = sanitizeForPrompt(p.wo.abstract, 'wo.abstract');
  const safeDoi = p.wo.doi !== undefined ? sanitizeForPrompt(p.wo.doi, 'wo.doi') : undefined;
  const safePlan = p.plan.map((s, i) => sanitizeForPrompt(s, `plan[${i}]`));
  const safeObservations = p.observations.map((o, i) => ({
    tool: sanitizeForPrompt(o.tool, `observation[${i}].tool`),
    result: sanitizeForPrompt(o.result, `observation[${i}].result`),
  }));
  const safeRelatedDois = p.relatedDois?.map((d, i) =>
    sanitizeForPrompt(d, `relatedDois[${i}]`),
  );

  const obsText = safeObservations.length === 0
    ? 'None yet.'
    : safeObservations.map((o, i) => `[${i + 1}] ${o.tool}: ${o.result}`).join('\n');

  const schemaBlock = renderDiscoverySchemasForPrompt();
  const doiLine = safeDoi ? `\nDOI: ${safeDoi}` : '';
  const related = safeRelatedDois?.length
    ? `\n\nRelated paper DOIs available for supporting_dois:\n${safeRelatedDois.map((d) => `  - ${d}`).join('\n')}`
    : '';

  return `You are a biomedical research agent analyzing a paper.

Work Order: ${safeTitle}
Abstract: ${safeAbstract}${doiLine}${related}

Execution Plan:
${safePlan.join('\n')}

Available Tools:
${p.availableTools}

Observations so far:
${obsText}

Based on your plan and observations, decide your next action.
If you need more context (e.g. search_corpus for related DOIs), use a tool.
Once you have enough grounding to fill a structured discovery, generate the final answer.

Output ONLY a JSON object (no markdown, no extra text).

To use a tool:
{"thought":"why","action":"use_tool","toolCall":{"toolName":"tool_name","params":{}}}

Available discoveryType schemas (you MUST match one exactly):
${schemaBlock}

To deliver the final answer:
{
  "thought": "<brief rationale>",
  "action": "generate_answer",
  "answer": {
    "summary": "<2-3 sentences, ≥ 80 chars — a summary under ~30 characters or a sentence fragment is auto-rejected and unrecoverable; always write 2-3 complete sentences>",
    "keyInsights": ["<insight, ≥ 30 chars>", "<insight>", "<insight>", "<insight>", "<insight>"],
    "proposal": "<prose paragraph (≥ 100 chars, ≥ 12 words) that describes the discovery in plain English, IMMEDIATELY FOLLOWED BY a JSON block {\\"discoveryType\\":\\"…\\",\\"structuredData\\":{…}} using the exact field names from the matching schema above>"
  }
}

Anti-patterns (these will be silently rejected by the coordinator):
- Wrong schema keys: \`"RxNorm"\`, \`"MeSH"\`, \`"UMLS CUI"\`. Use exactly \`drug_rxnorm_id\`, \`disease_mesh_id\`, \`umls_cui\` (snake_case, no spaces).
- Invented IDs: RxNorm RXCUIs are numeric (\`"7933"\`); never \`"R03945"\`. MeSH IDs are \`"D"\` + 6 digits; never free-text disease names.
- Multiple JSON objects in the proposal (\`}}, {\`). Output exactly ONE \`{discoveryType, structuredData}\` block per submission.
- Hallucinated DOIs. Every DOI must come from the abstract, observations, or the related-DOIs list above.

Rules:
- supporting_dois ≥ 2 real DOIs from the abstract, observations, or the related list. NEVER invent DOIs.
- evidence_type ↔ DOI count: use \`meta_analysis\` ONLY with ≥ 3 distinct real DOIs; with exactly 2 distinct real DOIs use \`literature_review\` (or another non-meta type), NEVER \`meta_analysis\`; with fewer than 2 use \`hypothesis_generation\` or \`gap_analysis\`. NEVER fabricate, duplicate, or pad DOIs to hit a threshold — match the evidence_type to the DOIs you actually extracted.
- If no structured discovery can be grounded, pick mechanism_link (weakest claim) and still ground ≥ 2 DOIs.
- summary and keyInsights are plain English, not JSON.
- Use the EXACT schema field names. The coordinator strictly validates them and silently drops payloads with wrong keys.`;
}
