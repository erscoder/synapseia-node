/**
 * RoundListener — subscribes to the coordinator WebSocket and listens for
 * 'round.closed', 'round.evaluating', and 'evaluation.assigned' events.
 * When a round closes, it checks if this node won.
 * When a round enters evaluation, it starts the peer review loop.
 */

import { Injectable } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import logger from '../../utils/logger.js';
import {
  startReviewLoop,
  stopReviewLoop,
  isReviewLoopRunning,
  type LLMReviewConfig,
} from './review-agent.js';

interface RoundWinner {
  rank: number;
  nodeId: string;
  rewardAmount: string; // lamports as string
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

let _socket: Socket | null = null;

/**
 * Connect to coordinator WS and start listening for round events.
 * @param coordinatorUrl  e.g. http://localhost:3701
 * @param peerId          This node's identity (used to check if it won)
 * @param llmConfig       LLM configuration for the peer review loop (optional)
 */
export function startRoundListener(
  coordinatorUrl: string,
  peerId: string,
  llmConfig?: LLMReviewConfig,
): void {
  if (_socket) return; // already connected

  _socket = io(coordinatorUrl, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  _socket.on('connect', () => {
    logger.log(`[RoundListener] Connected to coordinator WS (${coordinatorUrl})`);
  });

  _socket.on('disconnect', (reason) => {
    logger.log(`[RoundListener] Disconnected from coordinator WS: ${reason}`);
  });

  _socket.on('round.closed', (event: RoundClosedEvent) => {
    logger.log(`[RoundListener] Round closed: ${event.roundId} (workOrder: ${event.workOrderId})`);

    const myResult = event.winners.find(w => w.nodeId === peerId);
    const lamportsToSyn = (lamports: string) =>
      (Number(lamports) / 1e9).toFixed(9);

    if (myResult) {
      const rankEmoji = myResult.rank === 1 ? '🥇' : myResult.rank === 2 ? '🥈' : '🥉';
      logger.log(
        `[RoundListener] ${rankEmoji} YOU WON rank #${myResult.rank}! ` +
        `Reward: ${lamportsToSyn(myResult.rewardAmount)} SYN ` +
        `(submission: ${myResult.submissionId})`
      );
    } else if (event.winners.length > 0) {
      const winner = event.winners[0];
      logger.log(
        `[RoundListener] Round ended — you did not place. ` +
        `Winner: ${winner.nodeId.slice(0, 8)}... ` +
        `(${lamportsToSyn(winner.rewardAmount)} SYN)`
      );
    } else {
      logger.log(`[RoundListener] Round ended with no winners (no submissions).`);
    }
  });

  _socket.on('round.evaluating', (event: RoundEvaluatingEvent) => {
    logger.log(
      `[RoundListener] Round ${event.roundId} entered EVALUATING phase ` +
      `(${event.submissionCount} submissions). Starting peer review loop...`
    );
    if (llmConfig) {
      startReviewLoop(coordinatorUrl, peerId, llmConfig);
    } else {
      logger.warn('[RoundListener] No LLM config provided — skipping peer review loop');
    }
  });

  _socket.on('evaluation.assigned', (event: EvaluationAssignedEvent) => {
    if (event.evaluatorNodeId !== peerId) return; // not for us
    logger.log(`[RoundListener] Evaluation assignment received for submission ${event.submissionId}`);
    // Trigger immediate poll if not already running
    if (llmConfig && !isReviewLoopRunning()) {
      startReviewLoop(coordinatorUrl, peerId, llmConfig);
    } else if (llmConfig) {
      // Already running — the next cycle will pick up the assignment
      logger.log('[RoundListener] Review loop already running — assignment will be picked up next cycle');
    }
  });

  _socket.on('connect_error', (err) => {
    logger.warn(`[RoundListener] WS connect error: ${err.message} — retrying...`);
  });
}

export function stopRoundListener(): void {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
  stopReviewLoop();
}

export { startReviewLoop, stopReviewLoop, isReviewLoopRunning };

// ─── Injectable Service ───────────────────────────────────────────────────────

/**
 * Injectable service for the round listener.
 * Wraps all round listener functionality with NestJS DI support.
 */
@Injectable()
export class RoundListenerHelper {
  startRoundListener(coordinatorUrl: string, peerId: string, llmConfig?: LLMReviewConfig): void {
    startRoundListener(coordinatorUrl, peerId, llmConfig);
  }

  stopRoundListener(): void {
    stopRoundListener();
  }
}
