/**
 * Node: qualityGate
 * Extracts quality scoring + rate limiting logic
 * Returns { qualityScore, shouldSubmit }
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state.js';
import { scoreResearchResult, isResearchWorkOrder } from '../../work-order-agent.js';
import logger from '../../../../utils/logger.js';

// Rate limiting: max 1 submission per this many ms + random jitter
const SUBMISSION_RATE_LIMIT_MS = 10_000; // 10 seconds base
const SUBMISSION_MIN_SCORE = 0.15; // Minimum quality score threshold

// Track last submission time across iterations
let lastSubmissionAt = 0;

/**
 * Quality gate: evaluate execution result quality
 * - Scores research results
 * - Enforces rate limiting
 * - Returns whether result should be submitted
 */
export async function qualityGate(state: AgentState): Promise<Partial<AgentState>> {
  const { selectedWorkOrder, executionResult, researchResult } = state;

  // If execution failed, don't submit
  if (!executionResult?.success) {
    logger.warn(' Work order execution failed — skipping result submission to avoid polluting rewards');
    return { qualityScore: 0, shouldSubmit: false };
  }

  // For research work orders: check quality score
  if (selectedWorkOrder && isResearchWorkOrder(selectedWorkOrder) && researchResult) {
    const submissionScore = scoreResearchResult(researchResult);
    
    if (submissionScore < SUBMISSION_MIN_SCORE) {
      logger.warn(` Research score ${submissionScore.toFixed(4)} < threshold ${SUBMISSION_MIN_SCORE} — skipping submission`);
      return { qualityScore: submissionScore, shouldSubmit: false };
    }

    logger.log(` Research quality score: ${submissionScore.toFixed(4)}`);
  }

  // Rate limiting: wait if needed
  const now = Date.now();
  const jitterMs = Math.floor(Math.random() * SUBMISSION_RATE_LIMIT_MS);
  const nextAllowedAt = lastSubmissionAt + SUBMISSION_RATE_LIMIT_MS + jitterMs;
  
  if (now < nextAllowedAt) {
    const waitMs = nextAllowedAt - now;
    logger.log(` Rate limit: waiting ${(waitMs / 1000).toFixed(1)}s before submitting (jitter: ${(jitterMs / 1000).toFixed(1)}s)`);
    await sleep(waitMs);
  }
  
  lastSubmissionAt = Date.now();

  return {
    qualityScore: researchResult ? scoreResearchResult(researchResult) : 1.0,
    shouldSubmit: true,
  };
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reset last submission time (for testing)
 */
export function resetLastSubmissionTime(): void {
  lastSubmissionAt = 0;
}

/**
 * Get current rate limit state (for testing)
 */
export function getLastSubmissionTime(): number {
  return lastSubmissionAt;
}
