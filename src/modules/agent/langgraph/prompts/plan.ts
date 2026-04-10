/**
 * Planning prompt template for research work orders
 * Sprint B - Multi-step execution planning
 */

export interface PlanningPromptParams {
  title: string;
  abstract: string;
  memories: string;
}

/**
 * Build the planning prompt for the LLM
 */
export function buildPlanningPrompt(params: PlanningPromptParams): string {
  return `You are a research agent. Given this work order, create a step-by-step execution plan.

Work order: ${params.title}
Abstract: ${params.abstract}
Relevant memories: ${params.memories}

Output ONLY a JSON array of 3-5 step objects (no markdown, no extra text):
[{"id":"1","action":"<action>","description":"<what to do>"},...]

Valid actions: fetch_context, analyze_paper, cross_reference, generate_hypothesis, peer_review_prep.`;
}

/**
 * Default execution plan when LLM fails to generate valid plan
 */
export const DEFAULT_EXECUTION_PLAN = [
  { id: '1', action: 'fetch_context' as const, description: 'Search reference corpus for related work' },
  { id: '2', action: 'analyze_paper' as const, description: 'Extract key findings and methodology' },
  { id: '3', action: 'generate_hypothesis' as const, description: 'Formulate research hypothesis' },
];
