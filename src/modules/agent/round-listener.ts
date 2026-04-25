/**
 * RoundListener — subscribes to the coordinator WebSocket and listens for
 * round lifecycle events: close, evaluating, evaluation-assigned, and
 * Commit-Reveal V2 phase transitions.
 */

import { Injectable, Optional } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import logger from '../../utils/logger';
import { ReviewAgentHelper, type LLMReviewConfig } from './review-agent';
import { CommitRevealV2Helper } from './commit-reveal-v2';
import { setActiveMissions, type MissionBrief } from './mission-context-state';
import { recordRoundOutcome } from './performance-state';

interface RoundWinner {
  rank: number;
  nodeId: string;
  nodeName?: string;
  rewardAmount: string;
  submissionId: string;
}

interface RoundClosedEvent {
  roundId: string;
  workOrderId: string;
  winners: RoundWinner[];
  closedAt: string;
}

interface RoundEvaluatingEvent {
  roundId: string;
  submissionCount: number;
}

interface RoundOpenedEvent {
  roundId: string;
  endsAt: string;
  paperCount: number;
  /** Optional. Older coordinators don't ship this field — degrade silently. */
  missions?: MissionBrief[];
}

interface EvaluationAssignedEvent {
  submissionId: string;
  evaluatorNodeId: string;
  roundId: string;
}

@Injectable()
export class RoundListenerHelper {
  private socket: Socket | null = null;

  constructor(
    private readonly reviewAgentHelper: ReviewAgentHelper,
    @Optional() private readonly commitRevealV2?: CommitRevealV2Helper,
  ) {}

  startRoundListener(coordinatorUrl: string, peerId: string, llmConfig?: LLMReviewConfig): void {
    if (this.socket) return;

    this.socket = io(coordinatorUrl, {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      logger.log(`[RoundListener] Connected to coordinator WS (${coordinatorUrl})`);
    });

    this.socket.on('disconnect', (reason: string) => {
      logger.log(`[RoundListener] Disconnected from coordinator WS: ${reason}`);
    });

    this.socket.on('round.opened', (event: RoundOpenedEvent) => {
      const missionCount = event.missions?.length ?? 0;
      logger.log(
        `[RoundListener] Round opened: ${event.roundId} (${event.paperCount} papers, ` +
          `${missionCount} active mission${missionCount === 1 ? '' : 's'}). Caching mission brief for prompt injection.`,
      );
      setActiveMissions(event.missions ?? []);
    });

    this.socket.on('round.closed', (event: RoundClosedEvent) => {
      logger.log(`[RoundListener] Round closed: ${event.roundId} (workOrder: ${event.workOrderId})`);
      const myResult = event.winners.find(w => w.nodeId === peerId);
      const lamportsToSyn = (lamports: string) => (Number(lamports) / 1e9).toFixed(9);

      // Bucket C3: persist per-round outcome for the rolling performance
      // window. recordRoundOutcome rolls up a summary every 5 rounds.
      recordRoundOutcome({
        roundId: event.roundId,
        recordedAtMs: Date.now(),
        myRank: myResult?.rank ?? null,
        myRewardSyn: myResult ? Number(myResult.rewardAmount) / 1e9 : null,
        totalWinners: event.winners.length,
      });

      if (myResult) {
        const rankEmoji = myResult.rank === 1 ? '🥇' : myResult.rank === 2 ? '🥈' : '🥉';
        logger.log(
          `[RoundListener] ${rankEmoji} YOU WON rank #${myResult.rank}! ` +
          `Reward: ${lamportsToSyn(myResult.rewardAmount)} SYN ` +
          `(submission: ${myResult.submissionId})`
        );
      } else if (event.winners.length > 0) {
        const winnersList = event.winners
          .slice(0, 3)
          .map(w => {
            const name = w.nodeName ?? `${w.nodeId.slice(0, 8)}...`;
            const emoji = w.rank === 1 ? '🥇' : w.rank === 2 ? '🥈' : '🥉';
            return `${emoji} ${name}`;
          })
          .join(' | ');
        logger.log(
          `[RoundListener] Round ended — you did not place. ` +
          `Winners: ${winnersList}`
        );
      } else {
        logger.log('[RoundListener] Round ended with no winners (no submissions).');
      }
    });

    this.socket.on('round.evaluating', (event: RoundEvaluatingEvent) => {
      logger.log(
        `[RoundListener] Round ${event.roundId} entered EVALUATING phase ` +
        `(${event.submissionCount} submissions). Starting peer review loop...`
      );
      if (llmConfig) {
        this.reviewAgentHelper.startReviewLoop(coordinatorUrl, peerId, llmConfig);
      } else {
        logger.warn('[RoundListener] No LLM config provided — skipping peer review loop');
      }
    });

    this.socket.on('evaluation.assigned', (event: EvaluationAssignedEvent) => {
      if (event.evaluatorNodeId !== peerId) return;
      logger.log(`[RoundListener] Evaluation assignment received for submission ${event.submissionId}`);
      if (llmConfig && !this.reviewAgentHelper.isReviewLoopRunning()) {
        this.reviewAgentHelper.startReviewLoop(coordinatorUrl, peerId, llmConfig);
      } else if (llmConfig) {
        logger.log('[RoundListener] Review loop already running — assignment will be picked up next cycle');
      }
    });

    // ── Commit-Reveal V2 events ──────────────────────────────────────────

    this.socket.on('round.v2.commit_open', (event: { roundId: string; deadline: number }) => {
      if (!this.commitRevealV2) return;
      logger.log(`[RoundListener] V2 commit window open for round ${event.roundId} (deadline: ${event.deadline})`);
      // The helper needs the submission content to build the Merkle tree.
      // Fetch this node's submission from the coordinator.
      void (async () => {
        try {
          const res = await fetch(`${coordinatorUrl}/research-rounds/${event.roundId}/submissions`);
          if (!res.ok) return;
          const submissions = (await res.json()) as Array<{ nodeId: string; hypothesis: string; proposal?: string }>;
          const mine = submissions.find(s => s.nodeId === peerId);
          if (!mine) {
            logger.debug(`[RoundListener] V2: no submission found for round ${event.roundId} — skipping commit`);
            return;
          }
          const content = `${mine.hypothesis}\n\n${mine.proposal ?? ''}`.trim();
          await this.commitRevealV2!.handleCommitPhase(coordinatorUrl, peerId, event.roundId, content);
        } catch (err) {
          logger.warn(`[RoundListener] V2 commit error: ${(err as Error).message}`);
        }
      })();
    });

    this.socket.on('round.v2.challenge_issued', (event: { roundId: string; indices: number[]; deadline: number }) => {
      if (!this.commitRevealV2) return;
      logger.log(`[RoundListener] V2 challenge for round ${event.roundId}: indices [${event.indices.join(', ')}]`);
      void this.commitRevealV2.handleChallengeResponse(coordinatorUrl, peerId, event.roundId, event.indices)
        .catch(err => logger.warn(`[RoundListener] V2 prove error: ${(err as Error).message}`));
    });

    this.socket.on('round.v2.verified', (event: { roundId: string; verifiedPeers: string[]; failedPeers: string[] }) => {
      const isVerified = event.verifiedPeers.includes(peerId);
      const isFailed = event.failedPeers.includes(peerId);
      if (isVerified) {
        logger.log(`[RoundListener] ✓ V2 verification PASSED for round ${event.roundId}`);
      } else if (isFailed) {
        logger.warn(`[RoundListener] ✗ V2 verification FAILED for round ${event.roundId}`);
      }
    });

    this.socket.on('connect_error', (err: Error) => {
      logger.warn(`[RoundListener] WS connect error: ${err.message} — retrying...`);
    });
  }

  stopRoundListener(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.reviewAgentHelper.stopReviewLoop();
  }
}
