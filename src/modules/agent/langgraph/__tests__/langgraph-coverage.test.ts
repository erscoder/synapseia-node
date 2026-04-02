/**
 * Coverage tests for LangGraph nodes and edges
 * Sprint A - LangGraph Foundation
 * Target: ≥90% coverage on langgraph/**
 */

import { jest } from '@jest/globals';

// Mock trainer to avoid import.meta issues
jest.mock('../../../../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(() => ({ valid: true })),
  calculateImprovement: jest.fn(() => 0),
}));

// Mock fetch globally
global.fetch = jest.fn() as unknown as typeof fetch;

import type { AgentState } from '../state.js';
import { hasWorkOrders, shouldAccept, routeByType, shouldSubmitResult } from '../edges.js';
import { qualityGate, resetLastSubmissionTime, getLastSubmissionTime } from '../nodes/quality-gate.js';
import { submitResult } from '../nodes/submit-result.js';
import { executeResearch } from '../nodes/execute-research.js';
import { executeTraining } from '../nodes/execute-training.js';
import { executeInference } from '../nodes/execute-inference.js';
import { executeDiloco } from '../nodes/execute-diloco.js';
import { initBrain } from '../../agent-brain.js';
import type { WorkOrder } from '../../work-order-agent.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    availableWorkOrders: [],
    selectedWorkOrder: null,
    economicEvaluation: null,
    executionResult: null,
    researchResult: null,
    qualityScore: 0,
    shouldSubmit: false,
    submitted: false,
    accepted: false,
    brain: initBrain(),
    iteration: 1,
    config: {
      coordinatorUrl: 'http://localhost:3701',
      peerId: 'test_peer',
      capabilities: ['llm'],
      llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: undefined },
      intervalMs: 5000,
    },
    coordinatorUrl: 'http://localhost:3701',
    peerId: 'test_peer',
    capabilities: ['llm'],
    ...overrides,
  };
}

function makeResearchWO(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo_research',
    title: 'BRCA1 Breast Cancer Risk',
    description: JSON.stringify({
      title: 'BRCA1 Pathogenic Variants and Breast Cancer Risk',
      abstract: 'This study examines the relationship between BRCA1 mutations and breast cancer incidence in premenopausal women across three independent cohorts.',
    }),
    type: 'RESEARCH',
    requiredCapabilities: ['llm'],
    rewardAmount: '1000000000',
    status: 'PENDING',
    creatorAddress: 'creator',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─── Edges ────────────────────────────────────────────────────────────────────

describe('Edges', () => {
  describe('hasWorkOrders', () => {
    it('returns __end__ when no work orders', () => {
      expect(hasWorkOrders(makeState({ availableWorkOrders: [] }))).toBe('__end__');
    });

    it('returns selectBestWorkOrder when WOs available', () => {
      expect(hasWorkOrders(makeState({ availableWorkOrders: [makeResearchWO()] }))).toBe('selectBestWorkOrder');
    });
  });

  describe('shouldAccept', () => {
    it('returns fetchWorkOrders when no evaluation', () => {
      expect(shouldAccept(makeState({ economicEvaluation: null }))).toBe('fetchWorkOrders');
    });

    it('returns acceptWorkOrder when shouldAccept=true', () => {
      expect(shouldAccept(makeState({
        economicEvaluation: {
          shouldAccept: true, bountySyn: 1000000000n, bountyUsd: 0.01,
          estimatedCostUsd: 0, profitRatio: Infinity, reason: 'ollama',
        },
      }))).toBe('acceptWorkOrder');
    });

    it('returns fetchWorkOrders when shouldAccept=false', () => {
      expect(shouldAccept(makeState({
        economicEvaluation: {
          shouldAccept: false, bountySyn: 0n, bountyUsd: 0,
          estimatedCostUsd: 1, profitRatio: 0, reason: 'not profitable',
        },
      }))).toBe('fetchWorkOrders');
    });
  });

  describe('routeByType', () => {
    it('returns executeResearch for RESEARCH type', () => {
      expect(routeByType(makeState({ selectedWorkOrder: makeResearchWO({ type: 'RESEARCH' }) }))).toBe('executeResearch');
    });

    it('returns executeTraining for TRAINING type', () => {
      expect(routeByType(makeState({ selectedWorkOrder: makeResearchWO({ type: 'TRAINING' }) }))).toBe('executeTraining');
    });

    it('returns executeInference for CPU_INFERENCE type', () => {
      expect(routeByType(makeState({ selectedWorkOrder: makeResearchWO({ type: 'CPU_INFERENCE' }) }))).toBe('executeInference');
    });

    it('returns executeDiloco for DILOCO_TRAINING type', () => {
      expect(routeByType(makeState({ selectedWorkOrder: makeResearchWO({ type: 'DILOCO_TRAINING' }) }))).toBe('executeDiloco');
    });

    it('returns executeDefault for unknown type', () => {
      expect(routeByType(makeState({ selectedWorkOrder: makeResearchWO({ type: undefined }) }))).toBe('executeDefault');
    });

    it('returns executeDefault when no selectedWorkOrder', () => {
      expect(routeByType(makeState({ selectedWorkOrder: null }))).toBe('executeDefault');
    });
  });

  describe('shouldSubmitResult', () => {
    it('returns submitResult when shouldSubmit=true', () => {
      expect(shouldSubmitResult(makeState({ shouldSubmit: true }))).toBe('submitResult');
    });

    it('returns updateMemory when shouldSubmit=false', () => {
      expect(shouldSubmitResult(makeState({ shouldSubmit: false }))).toBe('updateMemory');
    });
  });
});

// ─── qualityGate ─────────────────────────────────────────────────────────────

describe('qualityGate node', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetLastSubmissionTime();
  });

  it('rejects failed execution', async () => {
    const result = await qualityGate(makeState({
      executionResult: { result: 'error', success: false },
    }));
    expect(result.shouldSubmit).toBe(false);
    expect(result.qualityScore).toBe(0);
  });

  it('rejects research result below min score', async () => {
    const result = await qualityGate(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: { result: '', success: true },
      researchResult: {
        summary: 'x', // too short
        keyInsights: [],
        proposal: 'y',
      },
    }));
    expect(result.shouldSubmit).toBe(false);
  });

  it('accepts research result with good quality', async () => {
    const result = await qualityGate(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: { result: '', success: true },
      researchResult: {
        summary: 'This study demonstrates that BRCA1 pathogenic variants significantly increase breast cancer risk in premenopausal women, with a 4.2x elevated risk observed across three independent cohorts.',
        keyInsights: [
          'BRCA1 p.Cys61Gly carriers show 4.2x elevated risk in premenopausal women',
          'Three independent cohorts confirm the association with statistical significance p<0.001',
          'Risk is highest in women under 40 with family history of breast cancer',
          'Variant penetrance varies by ancestry group with notable differences in Ashkenazi populations',
          'Prophylactic interventions reduce risk by 85% in carriers who undergo surgery before age 40',
        ],
        proposal: 'Integrate BRCA1 variant screening into decentralized medical research workflows. Implement federated learning nodes that analyze patient genomic data locally without centralizing sensitive information, using the p.Cys61Gly variant as a high-priority screening biomarker for risk stratification algorithms.',
      },
    }));
    expect(result.shouldSubmit).toBe(true);
    expect(result.qualityScore).toBeGreaterThan(0.7);
  });

  it('accepts non-research WO unconditionally', async () => {
    const result = await qualityGate(makeState({
      selectedWorkOrder: makeResearchWO({ type: 'TRAINING' }),
      executionResult: { result: '{"valLoss":0.4}', success: true },
    }));
    expect(result.shouldSubmit).toBe(true);
    expect(result.qualityScore).toBe(1.0);
  });

  it('updates lastSubmissionTime after accepting', async () => {
    resetLastSubmissionTime();
    const before = getLastSubmissionTime();
    await qualityGate(makeState({
      selectedWorkOrder: makeResearchWO({ type: 'TRAINING' }),
      executionResult: { result: 'ok', success: true },
    }));
    expect(getLastSubmissionTime()).toBeGreaterThan(before);
  });

  it('waits for rate limit when submissions are too fast (timer mock)', async () => {
    jest.useFakeTimers();
    resetLastSubmissionTime();

    // First submission
    const p1 = qualityGate(makeState({
      executionResult: { result: 'ok', success: true },
    }));
    jest.runAllTimers();
    await p1;

    // Second submission immediately after — should wait (rate limit active)
    const p2 = qualityGate(makeState({
      executionResult: { result: 'ok', success: true },
    }));
    jest.runAllTimers();
    const result = await p2;

    expect(result.shouldSubmit).toBe(true);
    jest.useRealTimers();
  });
});

// ─── submitResult ─────────────────────────────────────────────────────────────

describe('submitResult node', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns submitted=false when no work order', async () => {
    const result = await submitResult(makeState({ selectedWorkOrder: null }));
    expect(result.submitted).toBe(false);
  });

  it('returns submitted=false when no executionResult', async () => {
    const result = await submitResult(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: null,
    }));
    expect(result.submitted).toBe(false);
  });

  it('submits successfully and returns submitted=true', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // completeWorkOrder
    (fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // submitResearchResult

    const result = await submitResult(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: { result: '{"summary":"test"}', success: true },
      researchResult: {
        summary: 'Test summary',
        keyInsights: ['insight1'],
        proposal: 'Test proposal',
      },
    }));
    expect(result.submitted).toBe(true);
  });

  it('returns submitted=false when coordinator returns error', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: false, text: async () => 'error' });

    // Use a unique WO id to avoid idempotency guard from previous test
    const result = await submitResult(makeState({
      selectedWorkOrder: { ...makeResearchWO(), id: `wo_error_${Date.now()}` },
      executionResult: { result: 'result', success: true },
    }));
    expect(result.submitted).toBe(false);
  });
});

// ─── Executor nodes (error paths) ─────────────────────────────────────────────

describe('Executor nodes — null work order guard', () => {
  beforeEach(() => jest.resetAllMocks());

  it('executeResearch returns failure when no work order', async () => {
    const result = await executeResearch(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('executeTraining returns failure when no work order', async () => {
    const result = await executeTraining(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('executeInference returns failure when no work order', async () => {
    const result = await executeInference(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('executeDiloco returns failure when no work order', async () => {
    const result = await executeDiloco(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('executeResearch handles execution error gracefully', async () => {
    // Mock LLM to throw
    (fetch as any).mockRejectedValueOnce(new Error('LLM unavailable'));

    const result = await executeResearch(makeState({
      selectedWorkOrder: makeResearchWO(),
      config: {
        coordinatorUrl: 'http://localhost:3701',
        peerId: 'peer',
        capabilities: ['llm'],
        llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: undefined },
        intervalMs: 5000,
      },
    }));
    // Should not throw, returns failure
    expect(result.executionResult?.success).toBe(false);
  });
});
