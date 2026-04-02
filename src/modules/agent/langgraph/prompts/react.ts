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
If you need more context, use a tool.
If you have enough information, generate the final analysis.

Respond ONLY with valid JSON:
{
  "thought": "Your reasoning about what to do next",
  "action": "use_tool" | "generate_answer",
  "toolCall": { "toolName": "tool_name", "params": { ... } },  // only if action="use_tool"
  "answer": "Final structured analysis"  // only if action="generate_answer"
}`;
}
