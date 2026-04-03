/**
 * Agent Loop tests — re-exported from class-level specs.
 * The canonical tests live in:
 *   src/modules/agent/__tests__/agent-loop.spec.ts
 * This shim is kept to preserve the original test-file path; it simply
 * re-imports the helper and runs a minimal smoke-check so the old test runner
 * path stays green.
 */
import { describe, it, expect } from '@jest/globals';
import { AgentLoopHelper } from '../modules/agent/agent-loop';

describe('AgentLoopHelper (smoke via src/__tests__)', () => {
  it('instantiates with default state', () => {
    const helper = new AgentLoopHelper();
    const state = helper.getAgentLoopState();
    expect(state.isRunning).toBe(false);
    expect(state.iteration).toBe(0);
    expect(state.bestLoss).toBe(Infinity);
  });

  it('stopAgentLoop() sets isRunning=false', () => {
    const helper = new AgentLoopHelper();
    (helper as any).state.isRunning = true;
    helper.stopAgentLoop();
    expect(helper.getAgentLoopState().isRunning).toBe(false);
  });

  it('resetAgentLoopState() resets all fields', () => {
    const helper = new AgentLoopHelper();
    (helper as any).state = { iteration: 5, bestLoss: 0.1, totalExperiments: 5, isRunning: false };
    helper.resetAgentLoopState();
    const s = helper.getAgentLoopState();
    expect(s.iteration).toBe(0);
    expect(s.bestLoss).toBe(Infinity);
    expect(s.totalExperiments).toBe(0);
  });
});
