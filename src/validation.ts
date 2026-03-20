/**
 * Validation pulse rounds (A19)
 * Participation, verification, and challenge generation for validation
 */

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

export interface PulseChallenge {
  roundId: string;
  timestamp: number;
  difficulty: number;
  payload: string;
}

export interface PulseResult {
  roundId: string;
  peerId: string;
  response: string;
  latencyMs: number;
  valid: boolean;
}

@Injectable()
export class ValidationHelper {
  /**
   * Generate a validation challenge
   */
  generateChallenge(
    roundId?: string,
    difficulty: number = 1,
  ): PulseChallenge {
    const finalRoundId = roundId || `round-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = Buffer.from(randomBytes(32)).toString('hex');

    return {
      roundId: finalRoundId,
      timestamp: Date.now(),
      difficulty,
      payload,
    };
  }

  /**
   * Participate in a validation round
   * Returns response hash and measures latency
   */
  participateInPulse(
    challenge: PulseChallenge,
    peerId: string,
  ): PulseResult {
    const startTime = Date.now();

    // Compute hash: SHA256(payload + peerId + roundId)
    const message = `${challenge.payload}:${peerId}:${challenge.roundId}`;
    const hash = createHash('sha256').update(message).digest('hex');

    const endTime = Date.now();
    const latencyMs = endTime - startTime;

    // Valid if latency < 5000ms
    const valid = latencyMs < 5000;

    return {
      roundId: challenge.roundId,
      peerId,
      response: hash,
      latencyMs,
      valid,
    };
  }

  /**
   * Verify a pulse result
   * Recomputes hash and checks validity
   */
  verifyPulseResult(
    result: PulseResult,
    challenge: PulseChallenge,
  ): boolean {
    // Check if the hash matches
    const message = `${challenge.payload}:${result.peerId}:${challenge.roundId}`;
    const expectedHash = createHash('sha256').update(message).digest('hex');

    if (result.response !== expectedHash) {
      return false;
    }

    // Check latency requirement: must be < 5000ms * difficulty
    const maxLatency = 5000 * challenge.difficulty;
    if (result.latencyMs >= maxLatency) {
      return false;
    }

    return true;
  }

  /**
   * Check if a result is valid based on local criteria
   */
  isResultValid(result: PulseResult): boolean {
    return result.valid === true;
  }

  /**
   * Compute expected response for a challenge
   */
  computeExpectedResponse(
    challenge: PulseChallenge,
    peerId: string,
  ): string {
    const message = `${challenge.payload}:${peerId}:${challenge.roundId}`;
    return createHash('sha256').update(message).digest('hex');
  }

  /**
   * Get maximum allowed latency for a difficulty
   */
  getMaxLatency(difficulty: number): number {
    return 5000 * difficulty;
  }
}

// Backward-compatible standalone function exports
export const generateChallenge = (...args: Parameters<ValidationHelper['generateChallenge']>) =>
  new ValidationHelper().generateChallenge(...args);

export const participateInPulse = (...args: Parameters<ValidationHelper['participateInPulse']>) =>
  new ValidationHelper().participateInPulse(...args);

export const verifyPulseResult = (...args: Parameters<ValidationHelper['verifyPulseResult']>) =>
  new ValidationHelper().verifyPulseResult(...args);

export const isResultValid = (...args: Parameters<ValidationHelper['isResultValid']>) =>
  new ValidationHelper().isResultValid(...args);

export const computeExpectedResponse = (...args: Parameters<ValidationHelper['computeExpectedResponse']>) =>
  new ValidationHelper().computeExpectedResponse(...args);

export const getMaxLatency = (...args: Parameters<ValidationHelper['getMaxLatency']>) =>
  new ValidationHelper().getMaxLatency(...args);
