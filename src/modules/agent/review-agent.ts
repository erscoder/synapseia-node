/**
 * Review Agent — Peer Review Loop
 *
 * Polls the coordinator for evaluation assignments, fetches submissions,
 * uses the LLM to score on 4 dimensions, and POSTs evaluations.
 */

import { Injectable, Optional, OnModuleInit } from '@nestjs/common';
import logger from '../../utils/logger';
import { LlmProviderHelper, type LLMConfig, type LLMModel } from '../llm/llm-provider';
import { IdentityService } from '../identity/services/identity.service';
import { buildAuthHeaders } from '../../utils/node-auth';
import { parseLlmJson } from '../../shared/parse-llm-json';

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

// ─── Injectable Service ───────────────────────────────────────────────────────

@Injectable()
export class ReviewAgentHelper implements OnModuleInit {
  private readonly llmProvider = new LlmProviderHelper();
  static readonly POLL_INTERVAL_MS = 10 * 60 * 1000;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /**
   * Guard for overlapping poll cycles. The setInterval fires every 2 min but
   * a cycle can take longer when the LLM is slow, so without this lock the
   * initial `void` invocation in startReviewLoop + a late interval tick can
   * both see the same PENDING assignment in the list, both POST it, and the
   * second hits 400 "already completed" on the coordinator.
   */
  private cycleInFlight = false;
  private _keypair?: Uint8Array;
  private _publicKey?: Uint8Array;
  private _peerId?: string;

  constructor(@Optional() private readonly identityService?: IdentityService) {}

  async onModuleInit(): Promise<void> {
    if (this.identityService) {
      try {
        const identity = this.identityService.getOrCreate();
        if (identity?.privateKey && identity?.publicKey) {
          this._keypair = Buffer.from(identity.privateKey, 'hex');
          this._publicKey = Buffer.from(identity.publicKey, 'hex');
          this._peerId = identity.peerId;
        }
      } catch (err) {
        logger.warn('[ReviewAgent] Failed to load identity for signing:', (err as Error).message);
      }
    }
  }

  private async buildHeaders(method: string, path: string, body: unknown): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this._keypair && this._publicKey && this._peerId) {
      const auth = await buildAuthHeaders({ method, path, body, privateKey: this._keypair, publicKey: this._publicKey, peerId: this._peerId });
      Object.assign(headers, auth);
    }
    return headers;
  }

  async fetchEvaluationAssignments(
    coordinatorUrl: string,
    nodeId: string,
  ): Promise<EvaluationAssignment[]> {
    try {
      const path = `/evaluations/assignments?nodeId=${encodeURIComponent(nodeId)}`;
      const url = `${coordinatorUrl}${path}`;
      const headers = await this.buildHeaders('GET', path, {});
      const response = await fetch(url, { headers });
      if (!response.ok) {
        if (response.status === 404) return [];
        logger.warn(`[ReviewAgent] Failed to fetch assignments: ${response.status}`);
        return [];
      }
      const data = await response.json() as EvaluationAssignment[] | { assignments?: EvaluationAssignment[]; pending?: EvaluationAssignment[]; completed?: EvaluationAssignment[] };
      if (Array.isArray(data)) return data;
      // Coordinator returns { pending, completed } shape
      if ('pending' in data) return [...(data.pending ?? []), ...(data.completed ?? [])];
      return data.assignments ?? [];
    } catch (err) {
      logger.warn(`[ReviewAgent] fetchEvaluationAssignments error: ${(err as Error).message}`);
      return [];
    }
  }

  async fetchSubmissionsForRound(
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

  buildReviewPrompt(submission: Submission): string {
    let title = submission.title ?? 'Untitled';
    let summary = submission.summary ?? '';
    let keyInsights: string[] = submission.keyInsights ?? [];

    if (!summary && submission.result) {
      try {
        const parsed = JSON.parse(submission.result) as {
          summary?: string;
          keyInsights?: string[];
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

Score each dimension 0-10:

- accuracy (0-10): Are claims factually correct and supported by cited DOIs?
  0-3: Major factual errors or fabricated claims
  4-6: Mostly correct with minor evidence gaps
  7-10: All claims grounded in cited evidence

- novelty (0-10): Does this add insight beyond restating the source abstract?
  0-3: Pure paraphrase of the abstract
  4-6: Some synthesis but limited new insight
  7-10: Genuine novel connection, hypothesis, or cross-paper synthesis

- methodology (0-10): Is the analysis systematic and reproducible?
  0-3: No clear analytical method
  4-6: Reasonable approach with gaps
  7-10: Systematic, well-structured, reproducible

- conclusions (0-10): Are findings specific, actionable, and well-supported?
  0-3: Vague or unsupported conclusions
  4-6: Clear but limited actionability
  7-10: Specific, testable, directly actionable for the stated research goal

Respond ONLY with valid JSON (no markdown):
{"accuracy": N, "novelty": N, "methodology": N, "conclusions": N, "commentary": "one sentence"}`;
  }

  async scoreSubmission(
    submission: Submission,
    llmConfig: LLMReviewConfig,
  ): Promise<ReviewScores | null> {
    const prompt = this.buildReviewPrompt(submission);
    try {
      const raw = await this.llmProvider.generateLLM(llmConfig.llmModel, prompt, llmConfig.llmConfig);
      // parseLlmJson stripReasoning + JSON.parse + balanced-structure
      // recovery covers <think>, markdown fences (the first `{` skips
      // the fence), and trailing prose for providers that ignore
      // response_format.
      const result = parseLlmJson<ReviewScores>(raw);
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? 'review JSON parse failed');
      }
      const scores = result.value;
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

  async postEvaluation(
    coordinatorUrl: string,
    peerId: string,
    assignment: EvaluationAssignment,
    scores: ReviewScores,
  ): Promise<boolean> {
    try {
      const overallScore = (scores.accuracy + scores.novelty + scores.methodology + scores.conclusions) / 4;
      // coordinator expects qualityScore (0-1), justification (min 20 chars)
      const qualityScore = Math.round((overallScore / 10) * 100) / 100;
      const justification = scores.commentary.length >= 20
        ? scores.commentary
        : `${scores.commentary} (accuracy:${scores.accuracy} novelty:${scores.novelty} methodology:${scores.methodology})`.slice(0, 500);
      const evalBody = {
        submissionId: assignment.submissionId,
        qualityScore,
        justification,
      };
      const headers = await this.buildHeaders('POST', '/evaluations', evalBody);
      const response = await fetch(`${coordinatorUrl}/evaluations`, {
        method: 'POST',
        headers,
        body: JSON.stringify(evalBody),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.warn(`[ReviewAgent] Failed to post evaluation for ${assignment.submissionId}: ${response.status} ${body}`);
        return false;
      }
      logger.log(`[ReviewAgent] Evaluation posted for submission ${assignment.submissionId} (qualityScore: ${qualityScore.toFixed(2)})`);
      return true;
    } catch (err) {
      logger.warn(`[ReviewAgent] postEvaluation error: ${(err as Error).message}`);
      return false;
    }
  }

  async kickReviewCycle(
    coordinatorUrl: string,
    peerId: string,
    llmConfig: LLMReviewConfig,
  ): Promise<number> {
    return this.runReviewPollCycle(coordinatorUrl, peerId, llmConfig);
  }

  async runReviewPollCycle(
    coordinatorUrl: string,
    peerId: string,
    llmConfig: LLMReviewConfig,
  ): Promise<number> {
    if (this.cycleInFlight) {
      logger.log('[ReviewAgent] Skipping tick — previous cycle still in progress');
      return 0;
    }
    this.cycleInFlight = true;
    try {
      logger.log('[ReviewAgent] Running review poll cycle...');
      const assignments = await this.fetchEvaluationAssignments(coordinatorUrl, peerId);
      const pending = assignments.filter(a => a.status === 'pending');

      if (pending.length === 0) {
        logger.log('[ReviewAgent] No pending assignments');
        return 0;
      }

      // Dedupe by submissionId: defensive against stale PENDING twin rows
      // that may still exist in the coord DB from before the idempotent-
      // assignment fix. Multiple pending rows for the same submission mean
      // only one real evaluation to run.
      const seen = new Set<string>();
      const uniquePending = pending.filter(a => {
        if (seen.has(a.submissionId)) return false;
        seen.add(a.submissionId);
        return true;
      });

      logger.log(`[ReviewAgent] Found ${uniquePending.length} pending assignment(s)`);
      let processed = 0;

      for (const assignment of uniquePending) {
        const submissions = await this.fetchSubmissionsForRound(coordinatorUrl, assignment.roundId);
        const submission = submissions.find(s => s.id === assignment.submissionId) ?? submissions[0];
        if (!submission) {
          logger.warn(`[ReviewAgent] Submission ${assignment.submissionId} not found in round ${assignment.roundId}`);
          continue;
        }
        const scores = await this.scoreSubmission(submission, llmConfig);
        if (!scores) continue;
        const posted = await this.postEvaluation(coordinatorUrl, peerId, assignment, scores);
        if (posted) processed++;
      }

      logger.log(`[ReviewAgent] Processed ${processed}/${uniquePending.length} assignments`);
      return processed;
    } finally {
      this.cycleInFlight = false;
    }
  }

  startReviewLoop(coordinatorUrl: string, peerId: string, llmConfig: LLMReviewConfig): void {
    if (this.running) {
      logger.log('[ReviewAgent] Review loop already running');
      return;
    }
    this.running = true;
    logger.log(`[ReviewAgent] Starting peer review loop (interval: ${ReviewAgentHelper.POLL_INTERVAL_MS / 1000}s)`);

    void this.runReviewPollCycle(coordinatorUrl, peerId, llmConfig).catch(err =>
      logger.warn(`[ReviewAgent] Cycle error: ${(err as Error).message}`)
    );

    this.intervalHandle = setInterval(() => {
      void this.runReviewPollCycle(coordinatorUrl, peerId, llmConfig).catch(err =>
        logger.warn(`[ReviewAgent] Cycle error: ${(err as Error).message}`)
      );
    }, ReviewAgentHelper.POLL_INTERVAL_MS);
  }

  stopReviewLoop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    logger.log('[ReviewAgent] Review loop stopped');
  }

  isReviewLoopRunning(): boolean {
    return this.running;
  }
}
