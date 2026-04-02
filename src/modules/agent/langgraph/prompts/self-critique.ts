/**
 * Self-critique prompt template for research quality assessment
 * Sprint B - LLM reviews its own output
 */

export interface SelfCritiquePromptParams {
  title: string;
  summary: string;
  keyInsights: string;
  proposal: string;
}

/**
 * Build the self-critique prompt for the LLM
 */
export function buildSelfCritiquePrompt(params: SelfCritiquePromptParams): string {
  return `You are reviewing your own research analysis. Score it honestly.

Title: ${params.title}
Your analysis:
- Summary: ${params.summary}
- Key insights: ${params.keyInsights}
- Proposal: ${params.proposal}

Score each dimension 0-10:
- accuracy: Are claims factually supported by the abstract?
- completeness: Are all major findings covered?
- novelty: Are insights non-obvious (not just paraphrasing)?
- actionability: Is the proposal concrete and specific?

Threshold for passing: average ≥ 7.0

Return ONLY valid JSON:
{"accuracy": N, "completeness": N, "novelty": N, "actionability": N, "feedback": "one sentence on what to improve", "passed": true/false}`;
}

/**
 * Interface for the self-critique response from LLM
 */
export interface SelfCritiqueResponse {
  accuracy: number;
  completeness: number;
  novelty: number;
  actionability: number;
  feedback: string;
  passed: boolean;
}

/**
 * Parse and validate the self-critique response
 */
export function parseSelfCritiqueResponse(jsonText: string): SelfCritiqueResponse {
  try {
    const parsed = JSON.parse(jsonText) as SelfCritiqueResponse;
    
    // Validate required fields
    if (
      typeof parsed.accuracy !== 'number' ||
      typeof parsed.completeness !== 'number' ||
      typeof parsed.novelty !== 'number' ||
      typeof parsed.actionability !== 'number' ||
      typeof parsed.feedback !== 'string' ||
      typeof parsed.passed !== 'boolean'
    ) {
      throw new Error('Invalid response structure');
    }

    // Clamp scores to 0-10 range
    return {
      accuracy: Math.max(0, Math.min(10, parsed.accuracy)),
      completeness: Math.max(0, Math.min(10, parsed.completeness)),
      novelty: Math.max(0, Math.min(10, parsed.novelty)),
      actionability: Math.max(0, Math.min(10, parsed.actionability)),
      feedback: parsed.feedback,
      passed: parsed.passed,
    };
  } catch {
    // Return a failing critique if parsing fails
    return {
      accuracy: 5,
      completeness: 5,
      novelty: 5,
      actionability: 5,
      feedback: 'Failed to parse critique response - needs improvement',
      passed: false,
    };
  }
}

/**
 * Calculate average score from critique dimensions
 */
export function calculateAverageScore(critique: SelfCritiqueResponse): number {
  return (critique.accuracy + critique.completeness + critique.novelty + critique.actionability) / 4;
}
