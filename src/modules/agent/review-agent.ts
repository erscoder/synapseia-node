/**
 * Review Agent — Peer Review Loop
 *
 * Polls the coordinator for evaluation assignments, fetches submissions,
 * uses the LLM to score on 4 dimensions, and POSTs evaluations.
 *
 * Usage:
 *   startReviewLoop(coordinatorUrl, peerId, llmConfig)
 *   stopReviewLoop()
 */

import { Injectable } from '@nestjs/common';
import logger from '../../utils/logger.js';
import { generateLLM, type LLMConfig, type LLMModel } from '../llm/llm-provider.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LLMReviewConfig {
  llmModel: LLMModel;
  llmConfig?: LLMConfig;
}

export interface EvaluationAssignment {
  id: string;
  submissionId: string;
  roundId: string;
  evaluatorNodeId: string;
  status: 'pending' | 'completed' | 'failed';
}

export interface Submission {
  id: string;
  roundId: string;
  nodeId: string;
  summary?: string;
  keyInsights?: string[];
  proposal?: string;
  title?: string;
  result?: string;
}

export interface ReviewScores {
  accuracy: number;
  novelty: number;
  methodology: number;
  conclusions: number;
  commentary: string;
}

// ─── Module State ────────────────────────────────────────────────────────────

let _intervalHandle: ReturnType<typeof setInterval> | null = null;
let _isRunning = false;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Fetch pending evaluation assignments for this node.
 */
export async function fetchEvaluationAssignments(
  coordinatorUrl: string,
  nodeId: string,
): Promise<EvaluationAssignment[]> {
  try {
    const url = `${coordinatorUrl}/evaluations/assignments?nodeId=${encodeURIComponent(nodeId)}`;
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) return [];
      logger.warn(`[ReviewAgent] Failed to fetch assignments: ${response.status}`);
      return [];
    }
    const data = await response.json() as EvaluationAssignment[] | { assignments?: EvaluationAssignment[] };
    return Array.isArray(data) ? data : (data.assignments ?? []);
  } catch (err) {
    logger.warn(`[ReviewAgent] fetchEvaluationAssignments error: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Fetch submissions for a round.
 */
export async function fetchSubmissionsForRound(
  coordinatorUrl: string,
  roundId: string,
): Promise<Submission[]> {
  try {
    const url = `${coordinatorUrl}/research-rounds/${encodeURIComponent(roundId)}/submissions`;
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(`[ReviewAgent] Failed to fetch submissions for round ${roundId}: ${response.status}`);
      return [];
    }
    const data = await response.json() as Submission[] | { submissions?: Submission[] };
    return Array.isArray(data) ? data : (data.submissions ?? []);
  } catch (err) {
    logger.warn(`[ReviewAgent] fetchSubmissionsForRound error: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Build the LLM review prompt.
 */
export function buildReviewPrompt(submission: Submission): string {
  // Parse result JSON if needed
  let title = submission.title ?? 'Untitled';
  let summary = submission.summary ?? '';
  let keyInsights: string[] = submission.keyInsights ?? [];

  if (!summary && submission.result) {
    try {
      const parsed = JSON.parse(submission.result) as {
        summary?: string;
        keyInsights?: string[];
        proposal?: string;
      };
      summary = parsed.summary ?? '';
      keyInsights = parsed.keyInsights ?? [];
    } catch {
      summary = submission.result.slice(0, 500);
    }
  }

  const insightsText = keyInsights.length > 0
    ? keyInsights.join('\n- ')
    : 'No key insights provided';

  return `You are a peer reviewer in a decentralized AI research network. Evaluate this research submission.

Title: ${title}
Content: ${summary}
Key insights: ${insightsText}

Score each dimension 0-10 where 10 is perfect:
- accuracy: factual correctness
- novelty: new insights vs existing knowledge
- methodology: rigor of analysis
- conclusions: clarity and quality of findings

Respond ONLY with valid JSON (no markdown):
{"accuracy": N, "novelty": N, "methodology": N, "conclusions": N, "commentary": "one sentence"}`;
}

/**
 * Score a submission using the LLM.
 */
export async function scoreSubmission(
  submission: Submission,
  llmConfig: LLMReviewConfig,
): Promise<ReviewScores | null> {
  const prompt = buildReviewPrompt(submission);
  try {
    const raw = await generateLLM(llmConfig.llmModel, prompt, llmConfig.llmConfig);
    // Strip <think> blocks and markdown fences
    let jsonStr = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                       jsonStr.match(/```(?:json)?\s*([\s\S]*)/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    jsonStr = jsonMatch ? jsonMatch[0] : jsonStr;

    const scores = JSON.parse(jsonStr) as ReviewScores;

    // Validate and clamp
    const clamp = (n: unknown) => Math.max(0, Math.min(10, Number(n) || 0));
    return {
      accuracy: clamp(scores.accuracy),
      novelty: clamp(scores.novelty),
      methodology: clamp(scores.methodology),
      conclusions: clamp(scores.conclusions),
      commentary: String(scores.commentary ?? '').slice(0, 500),
    };
  } catch (err) {
    logger.warn(`[ReviewAgent] Failed to score submission ${submission.id}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * POST an evaluation to the coordinator.
 */
export async function postEvaluation(
  coordinatorUrl: string,
  peerId: string,
  assignment: EvaluationAssignment,
  scores: ReviewScores,
): Promise<boolean> {
  try {
    const overallScore = (scores.accuracy + scores.novelty + scores.methodology + scores.conclusions) / 4;
    const response = await fetch(`${coordinatorUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Node-ID': peerId,
      },
      body: JSON.stringify({
        submissionId: assignment.submissionId,
        roundId: assignment.roundId,
        evaluatorNodeId: peerId,
        score: overallScore,
        accuracy: scores.accuracy,
        novelty: scores.novelty,
        methodology: scores.methodology,
        conclusions: scores.conclusions,
        commentary: scores.commentary,
        dimensions: {
          accuracy: scores.accuracy,
          novelty: scores.novelty,
          methodology: scores.methodology,
          conclusions: scores.conclusions,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.warn(`[ReviewAgent] Failed to post evaluation for ${assignment.submissionId}: ${response.status} ${body}`);
      return false;
    }
    logger.log(`[ReviewAgent] Evaluation posted for submission ${assignment.submissionId} (score: ${overallScore.toFixed(2)})`);
    return true;
  } catch (err) {
    logger.warn(`[ReviewAgent] postEvaluation error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Run one review poll cycle: fetch assignments → fetch submissions → score → post.
 */
export async function runReviewPollCycle(
  coordinatorUrl: string,
  peerId: string,
  llmConfig: LLMReviewConfig,
): Promise<number> {
  logger.log('[ReviewAgent] Running review poll cycle...');

  const assignments = await fetchEvaluationAssignments(coordinatorUrl, peerId);
  const pending = assignments.filter(a => a.status === 'pending');

  if (pending.length === 0) {
    logger.log('[ReviewAgent] No pending assignments');
    return 0;
  }

  logger.log(`[ReviewAgent] Found ${pending.length} pending assignment(s)`);
  let processed = 0;

  for (const assignment of pending) {
    // Fetch submissions for the round to find the specific one
    const submissions = await fetchSubmissionsForRound(coordinatorUrl, assignment.roundId);
    const submission = submissions.find(s => s.id === assignment.submissionId) ?? submissions[0];

    if (!submission) {
      logger.warn(`[ReviewAgent] Submission ${assignment.submissionId} not found in round ${assignment.roundId}`);
      continue;
    }

    const scores = await scoreSubmission(submission, llmConfig);
    if (!scores) continue;

    const posted = await postEvaluation(coordinatorUrl, peerId, assignment, scores);
    if (posted) processed++;
  }

  logger.log(`[ReviewAgent] Processed ${processed}/${pending.length} assignments`);
  return processed;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the periodic review loop.
 * Safe to call multiple times — will not create duplicate intervals.
 */
export function startReviewLoop(
  coordinatorUrl: string,
  peerId: string,
  llmConfig: LLMReviewConfig,
): void {
  if (_isRunning) {
    logger.log('[ReviewAgent] Review loop already running');
    return;
  }

  _isRunning = true;
  logger.log(`[ReviewAgent] Starting peer review loop (interval: ${POLL_INTERVAL_MS / 1000}s)`);

  // Run immediately on start
  void runReviewPollCycle(coordinatorUrl, peerId, llmConfig).catch(err =>
    logger.warn(`[ReviewAgent] Cycle error: ${(err as Error).message}`)
  );

  _intervalHandle = setInterval(() => {
    void runReviewPollCycle(coordinatorUrl, peerId, llmConfig).catch(err =>
      logger.warn(`[ReviewAgent] Cycle error: ${(err as Error).message}`)
    );
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the periodic review loop.
 */
export function stopReviewLoop(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  _isRunning = false;
  logger.log('[ReviewAgent] Review loop stopped');
}

/**
 * Check if the review loop is currently running.
 */
export function isReviewLoopRunning(): boolean {
  return _isRunning;
}

// ─── Exports for testing ──────────────────────────────────────────────────────

export const _test = {
  fetchEvaluationAssignments,
  fetchSubmissionsForRound,
  buildReviewPrompt,
  scoreSubmission,
  postEvaluation,
  runReviewPollCycle,
  isReviewLoopRunning,
};

// ─── Injectable Service ───────────────────────────────────────────────────────

/**
 * Injectable service for the review agent.
 * Wraps all review loop functionality with NestJS DI support.
 */
@Injectable()
export class ReviewAgentHelper {
  fetchEvaluationAssignments(coordinatorUrl: string, nodeId: string): Promise<EvaluationAssignment[]> {
    return fetchEvaluationAssignments(coordinatorUrl, nodeId);
  }

  fetchSubmissionsForRound(coordinatorUrl: string, roundId: string): Promise<Submission[]> {
    return fetchSubmissionsForRound(coordinatorUrl, roundId);
  }

  buildReviewPrompt(submission: Submission): string {
    return buildReviewPrompt(submission);
  }

  scoreSubmission(
    submission: Submission,
    llmConfig: LLMReviewConfig,
  ): Promise<ReviewScores | null> {
    return scoreSubmission(submission, llmConfig);
  }

  postEvaluation(
    coordinatorUrl: string,
    peerId: string,
    assignment: EvaluationAssignment,
    scores: ReviewScores,
  ): Promise<boolean> {
    return postEvaluation(coordinatorUrl, peerId, assignment, scores);
  }

  runReviewPollCycle(
    coordinatorUrl: string,
    peerId: string,
    llmConfig: LLMReviewConfig,
  ): Promise<number> {
    return runReviewPollCycle(coordinatorUrl, peerId, llmConfig);
  }

  startReviewLoop(
    coordinatorUrl: string,
    peerId: string,
    llmConfig: LLMReviewConfig,
  ): void {
    startReviewLoop(coordinatorUrl, peerId, llmConfig);
  }

  stopReviewLoop(): void {
    stopReviewLoop();
  }

  isReviewLoopRunning(): boolean {
    return isReviewLoopRunning();
  }
}
