/**
 * Agent Brain smoke tests — canonical tests in:
 *   src/modules/agent/__tests__/agent-brain.spec.ts
 */
import { describe, it, expect } from '@jest/globals';
import { AgentBrainHelper } from '../modules/agent/agent-brain';

describe('AgentBrainHelper (smoke via src/__tests__)', () => {
  it('initBrain() returns fresh brain with default goals', () => {
    const helper = new AgentBrainHelper();
    const brain = helper.initBrain();
    expect(brain.goals).toEqual(['minimize loss', 'discover novel architectures']);
    expect(brain.totalExperiments).toBe(0);
    expect(brain.bestResult).toBeNull();
  });

  it('updateBrain() increments totalExperiments', () => {
    const helper = new AgentBrainHelper();
    const brain = helper.initBrain();
    helper.updateBrain(brain, { valLoss: 0.4, improved: true, mutation: 'lr' });
    expect(brain.totalExperiments).toBe(1);
  });

  it('getNextAction() returns rest after > 10 consecutive failures', () => {
    const helper = new AgentBrainHelper();
    const brain = helper.initBrain();
    brain.strategy.consecutiveFailures = 11;
    expect(helper.getNextAction(brain)).toBe('rest');
  });
});
