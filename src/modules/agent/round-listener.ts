/**
 * RoundListener — subscribes to the coordinator WebSocket and listens for
 * 'round.closed' events. When a round closes, it checks if this node won
 * and logs the result accordingly.
 */

import { io, Socket } from 'socket.io-client';

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

let _socket: Socket | null = null;

/**
 * Connect to coordinator WS and start listening for round.closed events.
 * @param coordinatorUrl  e.g. http://localhost:3001
 * @param peerId          This node's identity (used to check if it won)
 */
export function startRoundListener(coordinatorUrl: string, peerId: string): void {
  if (_socket) return; // already connected

  _socket = io(coordinatorUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  _socket.on('connect', () => {
    console.log(`[RoundListener] Connected to coordinator WS (${coordinatorUrl})`);
  });

  _socket.on('disconnect', (reason) => {
    console.log(`[RoundListener] Disconnected from coordinator WS: ${reason}`);
  });

  _socket.on('round.closed', (event: RoundClosedEvent) => {
    console.log(`[RoundListener] Round closed: ${event.roundId} (workOrder: ${event.workOrderId})`);

    const myResult = event.winners.find(w => w.nodeId === peerId);
    const lamportsToSyn = (lamports: string) =>
      (Number(lamports) / 1e9).toFixed(9);

    if (myResult) {
      const rankEmoji = myResult.rank === 1 ? '🥇' : myResult.rank === 2 ? '🥈' : '🥉';
      console.log(
        `[RoundListener] ${rankEmoji} YOU WON rank #${myResult.rank}! ` +
        `Reward: ${lamportsToSyn(myResult.rewardAmount)} SYN ` +
        `(submission: ${myResult.submissionId})`
      );
    } else if (event.winners.length > 0) {
      const winner = event.winners[0];
      console.log(
        `[RoundListener] Round ended — you did not place. ` +
        `Winner: ${winner.nodeId.slice(0, 8)}... ` +
        `(${lamportsToSyn(winner.rewardAmount)} SYN)`
      );
    } else {
      console.log(`[RoundListener] Round ended with no winners (no submissions).`);
    }
  });

  _socket.on('connect_error', (err) => {
    console.warn(`[RoundListener] WS connect error: ${err.message} — retrying...`);
  });
}

export function stopRoundListener(): void {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}
