/**
 * RoundListener — subscribes to the coordinator WebSocket and listens for
 * 'round.closed', 'round.evaluating', and 'evaluation.assigned' events.
 */

import { Injectable } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import logger from '../../utils/logger';
import { ReviewAgentHelper, type LLMReviewConfig } from './review-agent';

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

interface EvaluationAssignedEvent {
  submissionId: string;
  evaluatorNodeId: string;
  roundId: string;
}

@Injectable()
export class RoundListenerHelper {
  private socket: Socket | null = null;

  constructor(private readonly reviewAgentHelper: ReviewAgentHelper) {}

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

    this.socket.on('round.closed', (event: RoundClosedEvent) => {
      logger.log(`[RoundListener] Round closed: ${event.roundId} (workOrder: ${event.workOrderId})`);
      const myResult = event.winners.find(w => w.nodeId === peerId);
      const lamportsToSyn = (lamports: string) => (Number(lamports) / 1e9).toFixed(9);

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
