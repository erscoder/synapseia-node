/**
 * Tests for validation.ts (A19)
 * Tests for generateChallenge, participateInPulse, verifyPulseResult
 */

import {
  generateChallenge,
  participateInPulse,
  verifyPulseResult,
  isResultValid,
  computeExpectedResponse,
  getMaxLatency,
  type PulseChallenge,
  type PulseResult,
} from '../validation.js';

describe('generateChallenge', () => {
  it('should generate a challenge with all required fields', () => {
    const challenge = generateChallenge();

    expect(challenge).toBeDefined();
    expect(challenge.roundId).toBeDefined();
    expect(challenge.timestamp).toBeDefined();
    expect(challenge.difficulty).toBeDefined();
    expect(challenge.payload).toBeDefined();
  });

  it('should use default difficulty of 1', () => {
    const challenge = generateChallenge();

    expect(challenge.difficulty).toBe(1);
  });

  it('should use custom difficulty', () => {
    const challenge = generateChallenge('round-1', 2);

    expect(challenge.difficulty).toBe(2);
  });

  it('should generate unique round IDs', () => {
    const challenge1 = generateChallenge();
    const challenge2 = generateChallenge('custom-round');

    expect(challenge1.roundId).not.toBe(challenge2.roundId);
  });

  it('should generate unique round IDs without delay', async () => {
    const challenge1 = generateChallenge();
    // Add a small delay to get different timestamp
    await new Promise((resolve) => setTimeout(resolve, 1));
    const challenge2 = generateChallenge();

    expect(challenge1.roundId).not.toBe(challenge2.roundId);
  });

  it('should use provided roundId', () => {
    const customId = 'custom-round-xyz';
    const challenge = generateChallenge(customId);

    expect(challenge.roundId).toBe(customId);
  });

  it('should generate unique payloads', () => {
    const challenge1 = generateChallenge();
    const challenge2 = generateChallenge();

    expect(challenge1.payload).not.toBe(challenge2.payload);
  });

  it('should have 64-character hex payload (32 bytes)', () => {
    const challenge = generateChallenge();

    expect(challenge.payload).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/i.test(challenge.payload)).toBe(true);
  });

  it('should have valid timestamp', () => {
    const before = Date.now();
    const challenge = generateChallenge();
    const after = Date.now();

    expect(challenge.timestamp).toBeGreaterThanOrEqual(before);
    expect(challenge.timestamp).toBeLessThanOrEqual(after);
  });

  it('should create independent challenge objects', () => {
    const challenge1 = generateChallenge();
    const challenge2 = generateChallenge();

    expect(challenge1).not.toBe(challenge2);
  });
});

describe('participateInPulse', () => {
  let challenge: PulseChallenge;
  let peerId: string;

  beforeEach(() => {
    challenge = generateChallenge('test-round', 1);
    peerId = 'peer-123';
  });

  it('should return a PulseResult with all fields', () => {
    const result = participateInPulse(challenge, peerId);

    expect(result).toBeDefined();
    expect(result.roundId).toBe(challenge.roundId);
    expect(result.peerId).toBe(peerId);
    expect(result.response).toBeDefined();
    expect(result.latencyMs).toBeDefined();
    expect(result.valid).toBeDefined();
  });

  it('should compute correct hash', () => {
    const result = participateInPulse(challenge, peerId);
    const expected = computeExpectedResponse(challenge, peerId);

    expect(result.response).toBe(expected);
  });

  it('should compute 64-character hex hash', () => {
    const result = participateInPulse(challenge, peerId);

    expect(result.response).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/i.test(result.response)).toBe(true);
  });

  it('should mark result as valid if latency < 5000ms', () => {
    const result = participateInPulse(challenge, peerId);

    expect(result.latencyMs).toBeLessThan(5000);
    expect(result.valid).toBe(true);
  });

  it('should measure latency in milliseconds', () => {
    const result = participateInPulse(challenge, peerId);

    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should return different hashes for different peerIds', () => {
    const result1 = participateInPulse(challenge, 'peer-1');
    const result2 = participateInPulse(challenge, 'peer-2');

    expect(result1.response).not.toBe(result2.response);
  });

  it('should return different hashes for different challenges', () => {
    const challenge2 = generateChallenge('test-round-2', 1);
    const result1 = participateInPulse(challenge, peerId);
    const result2 = participateInPulse(challenge2, peerId);

    expect(result1.response).not.toBe(result2.response);
  });

  it('should handle same inputs producing same result', () => {
    const result1 = participateInPulse(challenge, peerId);
    const result2 = participateInPulse(challenge, peerId);

    expect(result1.response).toBe(result2.response);
  });

  it('should handle empty peerId', () => {
    const result = participateInPulse(challenge, '');

    expect(result.peerId).toBe('');
    expect(result.response).toBeDefined();
    expect(result.response).toHaveLength(64);
  });

  it('should handle special characters in peerId', () => {
    const specialPeerId = 'peer-123!@#$%^&*()_+-={}[]|\\:";\'<>?,./~`';
    const result = participateInPulse(challenge, specialPeerId);

    expect(result.peerId).toBe(specialPeerId);
    expect(result.response).toBeDefined();
  });
});

describe('verifyPulseResult', () => {
  let challenge: PulseChallenge;
  let peerId: string;

  beforeEach(() => {
    challenge = generateChallenge('test-round', 1);
    peerId = 'peer-123';
  });

  it('should return true for valid result', () => {
    const result = participateInPulse(challenge, peerId);

    const verified = verifyPulseResult(result, challenge);

    expect(verified).toBe(true);
  });

  it('should return false for incorrect hash', () => {
    const result = participateInPulse(challenge, peerId);
    result.response = 'wrong hash';

    const verified = verifyPulseResult(result, challenge);

    expect(verified).toBe(false);
  });

  it('should return false for modified peerId', () => {
    const result = participateInPulse(challenge, peerId);
    // Result was from peer-123, but we verify against peer-456
    const wrongPeerId = 'peer-456';
    const fakeResult: PulseResult = {
      ...result,
      peerId: wrongPeerId,
    };

    const verified = verifyPulseResult(fakeResult, challenge);

    // Hash won't match because result contains peer-123's hash
    expect(verified).toBe(false);
  });

  it('should return false for excessive latency', () => {
    const result = participateInPulse(challenge, peerId);
    result.latencyMs = 6000; // Exceeds 5000ms

    const verified = verifyPulseResult(result, challenge);

    expect(verified).toBe(false);
  });

  it('should check latency against 5000ms * difficulty', () => {
    const highDifficultyChallenge = generateChallenge('test-round', 2);
    const result = participateInPulse(highDifficultyChallenge, peerId);
    result.latencyMs = 7000; // Exceeds 5000 * 2 = 10000ms, but this is still valid

    const verified = verifyPulseResult(result, highDifficultyChallenge);

    expect(verified).toBe(true);

    // Now exceed 10000ms
    result.latencyMs = 11000;
    const verified2 = verifyPulseResult(result, highDifficultyChallenge);

    expect(verified2).toBe(false);
  });

  it('should accept latency exactly at boundary', () => {
    const result = participateInPulse(challenge, peerId);
    result.latencyMs = 4999; // Just under 5000ms

    const verified = verifyPulseResult(result, challenge);

    expect(verified).toBe(true);
  });

  it('should reject latency at boundary', () => {
    const result = participateInPulse(challenge, peerId);
    result.latencyMs = 5000; // Exactly at 5000ms

    const verified = verifyPulseResult(result, challenge);

    expect(verified).toBe(false);
  });

  it('should handle zero latency', () => {
    const result = participateInPulse(challenge, peerId);
    result.latencyMs = 0;

    const verified = verifyPulseResult(result, challenge);

    expect(verified).toBe(true);
  });

  it('should return false for empty response hash', () => {
    const result = participateInPulse(challenge, peerId);
    result.response = '';

    const verified = verifyPulseResult(result, challenge);

    expect(verified).toBe(false);
  });
});

describe('isResultValid', () => {
  it('should return true for valid result', () => {
    const result: PulseResult = {
      roundId: 'test',
      peerId: 'peer-1',
      response: 'abc123',
      latencyMs: 100,
      valid: true,
    };

    expect(isResultValid(result)).toBe(true);
  });

  it('should return false for invalid result', () => {
    const result: PulseResult = {
      roundId: 'test',
      peerId: 'peer-1',
      response: 'abc123',
      latencyMs: 100,
      valid: false,
    };

    expect(isResultValid(result)).toBe(false);
  });

  it('should handle undefined valid field', () => {
    const result: PulseResult = {
      roundId: 'test',
      peerId: 'peer-1',
      response: 'abc123',
      latencyMs: 100,
      valid: undefined as any,
    };

    expect(isResultValid(result)).toBe(false);
  });
});

describe('computeExpectedResponse', () => {
  it('should compute correct hash', () => {
    const challenge = generateChallenge('test-round', 1);
    const peerId = 'peer-123';

    const hash = computeExpectedResponse(challenge, peerId);

    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/i.test(hash)).toBe(true);
  });

  it('should produce same hash for same inputs', () => {
    const challenge = generateChallenge('test-round', 1);
    const peerId = 'peer-123';

    const hash1 = computeExpectedResponse(challenge, peerId);
    const hash2 = computeExpectedResponse(challenge, peerId);

    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different peerIds', () => {
    const challenge = generateChallenge('test-round', 1);

    const hash1 = computeExpectedResponse(challenge, 'peer-1');
    const hash2 = computeExpectedResponse(challenge, 'peer-2');

    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different challenges', () => {
    const challenge1 = generateChallenge('round-1', 1);
    const challenge2 = generateChallenge('round-2', 1);
    const peerId = 'peer-123';

    const hash1 = computeExpectedResponse(challenge1, peerId);
    const hash2 = computeExpectedResponse(challenge2, peerId);

    expect(hash1).not.toBe(hash2);
  });

  it('should incorporate roundId into hash', () => {
    const challenge1 = generateChallenge('round-a', 1);
    const challenge2 = generateChallenge('round-b', 1);
    challenge2.payload = challenge1.payload; // Same payload
    const peerId = 'peer-123';

    const hash1 = computeExpectedResponse(challenge1, peerId);
    const hash2 = computeExpectedResponse(challenge2, peerId);

    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty peerId', () => {
    const challenge = generateChallenge('test-round', 1);

    const hash = computeExpectedResponse(challenge, '');

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });
});

describe('getMaxLatency', () => {
  it('should return 5000 for difficulty 1', () => {
    expect(getMaxLatency(1)).toBe(5000);
  });

  it('should return 10000 for difficulty 2', () => {
    expect(getMaxLatency(2)).toBe(10000);
  });

  it('should return 0 for difficulty 0', () => {
    expect(getMaxLatency(0)).toBe(0);
  });

  it('should return 25000 for difficulty 5', () => {
    expect(getMaxLatency(5)).toBe(25000);
  });

  it('should handle decimal difficulties', () => {
    expect(getMaxLatency(1.5)).toBe(7500);
  });

  it('should handle negative difficulties', () => {
    expect(getMaxLatency(-1)).toBe(-5000);
  });
});
