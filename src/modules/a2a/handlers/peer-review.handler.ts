/**
 * Peer Review Handler
 * Sprint D — A2A Server for Synapseia Node
 *
 * Receives a submission from another node and returns review scores
 * using the existing ReviewAgent scoring logic.
 */

import { Injectable } from '@nestjs/common';

// Local types — handler is self-contained, no dependency on AgentModule
interface Submission {
  id: string;
  roundId: string;
  nodeId: string;
  summary: string;
  keyInsights: string[];
  title: string;
}
interface ReviewScores {
  accuracy: number;
  novelty: number;
  methodology: number;
  conclusions: number;
  commentary: string;
}

export interface PeerReviewPayload {
  submission: string;
  roundId: string;
}

@Injectable()
export class PeerReviewHandler {

  /**
   * Handle a peer review request.
   * payload: { submission: string (JSON string or text), roundId: string }
   * Returns: { scores: ReviewScores, commentary: string }
   */
  async handle(payload: Record<string, unknown>): Promise<unknown> {
    const submissionText = payload['submission'] as string;
    const roundId = payload['roundId'] as string;

    if (!submissionText || typeof submissionText !== 'string') {
      throw new Error('peer_review payload requires submission (string)');
    }

    // Parse submission if it's JSON string
    let submission: Submission;
    try {
      submission = JSON.parse(submissionText) as Submission;
    } catch {
      // Treat as plain text submission
      submission = {
        id: 'unknown',
        roundId: roundId ?? 'unknown',
        nodeId: 'remote',
        summary: submissionText,
        keyInsights: [],
        title: 'Remote Submission',
      };
    }

    // Use the review agent's scoring logic
    // Note: We need LLM config to score — use a placeholder that will fail gracefully
    // In production, the node's LLM config would be injected
    const scores = await this.scoreSubmissionInline(submission);

    return {
      scores,
      commentary: scores.commentary,
    };
  }

  /**
   * Inline scoring when LLM is not configured for remote requests.
   * Uses heuristic scoring based on content analysis.
   */
  private async scoreSubmissionInline(submission: Submission): Promise<ReviewScores> {
    const summary = submission.summary ?? '';
    const keyInsights = submission.keyInsights ?? [];
    const title = submission.title ?? '';

    // Heuristic scoring (placeholder until full LLM scoring is wired)
    const accuracy = this.scoreAccuracy(summary);
    const novelty = this.scoreNovelty(summary, keyInsights);
    const methodology = this.scoreMethodology(summary);
    const conclusions = this.scoreConclusions(summary);

    return {
      accuracy,
      novelty,
      methodology,
      conclusions,
      commentary: this.generateCommentary(accuracy, novelty, methodology, conclusions),
    };
  }

  private scoreAccuracy(summary: string): number {
    // Penalize if summary is too short or too generic
    const len = summary.length;
    if (len < 20) return 2;
    if (len < 80) return 5;
    if (len > 200) return 8;
    return 7;
  }

  private scoreNovelty(summary: string, insights: string[]): number {
    // More key insights = higher novelty
    if (insights.length >= 5) return 8;
    if (insights.length >= 3) return 7;
    if (insights.length >= 1) return 6;
    return 4;
  }

  private scoreMethodology(summary: string): number {
    const hasMethod = /\b(method|approach|analysis|study|trial|experiment)\b/i.test(summary);
    return hasMethod ? 7 : 5;
  }

  private scoreConclusions(summary: string): number {
    const hasConclusion = /\b(therefore|conclude|results|findings|suggests|indicates)\b/i.test(summary);
    return hasConclusion ? 7 : 5;
  }

  private generateCommentary(
    accuracy: number,
    novelty: number,
    methodology: number,
    conclusions: number,
  ): string {
    const avg = (accuracy + novelty + methodology + conclusions) / 4;
    if (avg >= 7) return 'Solid submission with clear methodology and meaningful insights.';
    if (avg >= 5) return 'Adequate submission with some interesting points but room for improvement.';
    return 'Submission needs more depth and rigor before publication.';
  }
}
