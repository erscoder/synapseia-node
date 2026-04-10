/**
 * ReAct prompt template
 * Sprint C - ReAct Tool Calling
 */

export function buildReActPrompt(
  wo: { title: string; abstract: string },
  plan: string[],
  availableTools: string,
  observations: Array<{ tool: string; result: string }>,
): string {
  const obsText = observations.length === 0
    ? 'None yet.'
    : observations.map((o, i) => `[${i + 1}] ${o.tool}: ${o.result}`).join('\n');

  return `You are a scientific research agent analyzing a paper.

Work Order: ${wo.title}
Abstract: ${wo.abstract}

Execution Plan:
${plan.join('\n')}

Available Tools:
${availableTools}

Observations so far:
${obsText}

Based on your plan and observations, decide your next action.
If you need more context, use a tool. If you have enough information, generate the final analysis.

Output ONLY a JSON object (no markdown, no extra text).

To use a tool:
{"thought":"why you need the tool","action":"use_tool","toolCall":{"toolName":"tool_name","params":{}}}

To deliver the final answer, populate every field with REAL content derived from the abstract and observations:
{"thought":"brief rationale","action":"generate_answer","answer":{"summary":"REAL multi-sentence synthesis here","keyInsights":["REAL finding 1","REAL finding 2","REAL finding 3","REAL finding 4","REAL finding 5"],"proposal":"REAL concrete next step here"}}

Answer field requirements:
- summary: 3-4 sentences — state the core problem, the method used, the main result, and why it matters. Must be at least 80 characters.
- keyInsights: exactly 5 non-obvious findings extracted from the paper. Each at least 30 characters. No paraphrasing the abstract.
- proposal: a concrete follow-up research or application proposal. At least 100 characters. Include mechanism, implementation approach, and success criteria.`;
}
