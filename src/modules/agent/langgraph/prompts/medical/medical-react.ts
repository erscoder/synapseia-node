/**
 * Medical variant of the ReAct prompt (single-agent path in
 * execute-research.ts). Steers the same tool-calling loop toward a
 * structured biomedical discovery payload.
 */

import { renderDiscoverySchemasForPrompt } from './schemas';

export interface MedicalReActParams {
  wo: { title: string; abstract: string; doi?: string };
  plan: string[];
  availableTools: string;
  observations: Array<{ tool: string; result: string }>;
  relatedDois?: string[];
}

export function buildMedicalReActPrompt(p: MedicalReActParams): string {
  const obsText = p.observations.length === 0
    ? 'None yet.'
    : p.observations.map((o, i) => `[${i + 1}] ${o.tool}: ${o.result}`).join('\n');

  const schemaBlock = renderDiscoverySchemasForPrompt();
  const doiLine = p.wo.doi ? `\nDOI: ${p.wo.doi}` : '';
  const related = p.relatedDois?.length
    ? `\n\nRelated paper DOIs available for supporting_dois:\n${p.relatedDois.map((d) => `  - ${d}`).join('\n')}`
    : '';

  return `You are a biomedical research agent analyzing a paper.

Work Order: ${p.wo.title}
Abstract: ${p.wo.abstract}${doiLine}${related}

Execution Plan:
${p.plan.join('\n')}

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
    "summary": "<2-3 sentences, ≥ 80 chars>",
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
- If no structured discovery can be grounded, pick mechanism_link (weakest claim) and still ground ≥ 2 DOIs.
- summary and keyInsights are plain English, not JSON.
- Use the EXACT schema field names. The coordinator strictly validates them and silently drops payloads with wrong keys.`;
}
