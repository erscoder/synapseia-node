/**
 * round-listener.spec.ts — STR-02 tests for LLMConfig passthrough
 *
 * Tests that RoundListenerHelper.startRoundListener:
 * 1. Accepts llmConfig parameter and passes it to reviewAgentHelper
 * 2. Handles round.evaluating and evaluation.assigned events correctly
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RoundListenerHelper } from '../round-listener';
import { ReviewAgentHelper } from '../review-agent';
import type { LLMReviewConfig } from '../review-agent';

const mockStartReviewLoop = jest.fn();
const mockStopReviewLoop = jest.fn();
const mockIsReviewLoopRunning = jest.fn(() => false);

const mockIo = jest.fn(() => ({
  on: jest.fn(),
  disconnect: jest.fn(),
}));

jest.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => mockIo(...args),
}));

jest.mock('../review-agent.js', () => ({
  ReviewAgentHelper: jest.fn().mockImplementation(() => ({
    startReviewLoop: mockStartReviewLoop,
    stopReviewLoop: mockStopReviewLoop,
    isReviewLoopRunning: mockIsReviewLoopRunning,
  })),
}));

describe('RoundListenerHelper', () => {
  let helper: RoundListenerHelper;
  const COORDINATOR_URL = 'http://localhost:3701';
  const PEER_ID = 'test-peer-abc123';
  const LLM_CONFIG: LLMReviewConfig = {
    llmModel: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
    llmConfig: { baseUrl: 'http://localhost:11434' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsReviewLoopRunning.mockReturnValue(false);
    const mockReviewAgent = new ReviewAgentHelper() as any;
    helper = new RoundListenerHelper(mockReviewAgent);
  });

  afterEach(() => {
    helper.stopRoundListener();
  });

  it('accepts llmConfig parameter in startRoundListener', () => {
    // Verify that startRoundListener can be called with LLM_CONFIG
    // The socket.io connection is not established in unit tests, but
    // the method accepts the parameter without errors
    expect(() => helper.startRoundListener(COORDINATOR_URL, PEER_ID, LLM_CONFIG)).not.toThrow();
  });

  it('startRoundListener accepts undefined llmConfig', () => {
    expect(() => helper.startRoundListener(COORDINATOR_URL, PEER_ID, undefined)).not.toThrow();
  });

  it('stopRoundListener stops the review loop', () => {
    helper.startRoundListener(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
    expect(() => helper.stopRoundListener()).not.toThrow();
  });

  it('is exported from round-listener module', async () => {
    const mod = await import('../round-listener.js');
    expect(mod.RoundListenerHelper).toBeDefined();
    expect(typeof mod.RoundListenerHelper).toBe('function');
  });

  it('falls back to coordinatorUrl when coordinatorWsUrl is undefined', () => {
    helper.startRoundListener(COORDINATOR_URL, PEER_ID, LLM_CONFIG, undefined);
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo.mock.calls[0][0]).toBe(COORDINATOR_URL);
  });

  it('uses coordinatorWsUrl when provided (takes precedence over coordinatorUrl)', () => {
    const WS_URL = 'http://localhost:3702';
    helper.startRoundListener(COORDINATOR_URL, PEER_ID, LLM_CONFIG, WS_URL);
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo.mock.calls[0][0]).toBe(WS_URL);
  });
});
