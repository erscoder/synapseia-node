/**
 * Coverage tests - Part 2: executors, fetch, evaluate, state
 * Sprint A - LangGraph Foundation
 */

import { jest } from '@jest/globals';

jest.mock('../../../../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(() => ({ valid: true })),
  calculateImprovement: jest.fn(() => 0),
}));

jest.mock('../../work-order-agent', () => {
  const actual = jest.requireActual('../../work-order-agent') as Record<string, unknown>;
  return {
    ...actual,
    executeTrainingWorkOrder: jest.fn(),
    executeCpuInferenceWorkOrder: jest.fn(),
    executeDiLoCoWorkOrder: jest.fn(),
    executeResearchWorkOrder: jest.fn(),
    fetchAvailableWorkOrders: jest.fn(),
  };
});

global.fetch = jest.fn() as unknown as typeof fetch;

import type { AgentState } from '../state';
import { createInitialAgentState } from '../state';
import {
  executeTrainingWorkOrder,
  executeCpuInferenceWorkOrder,
  executeDiLoCoWorkOrder,
  executeResearchWorkOrder,
  fetchAvailableWorkOrders,
} from '../../work-order-agent';
import { ExecuteTrainingNode } from '../nodes/execute-training';
import { ExecuteInferenceNode } from '../nodes/execute-inference';
import { ExecuteDilocoNode } from '../nodes/execute-diloco';
import { ExecuteResearchNode } from '../nodes/execute-research';
import { FetchWorkOrdersNode } from '../nodes/fetch-work-orders';
import { EvaluateEconomicsNode } from '../nodes/evaluate-economics';
import { initBrain } from '../../agent-brain';
import type { WorkOrder, WorkOrderAgentConfig } from '../../work-order-agent';

const TEST_CONFIG: WorkOrderAgentConfig = {
  coordinatorUrl: 'http://localhost:3701',
  peerId: 'test_peer',
  capabilities: ['llm'],
  llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: undefined },
  intervalMs: 5000,
};

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
    config: TEST_CONFIG,
    coordinatorUrl: TEST_CONFIG.coordinatorUrl,
    peerId: TEST_CONFIG.peerId,
    capabilities: TEST_CONFIG.capabilities,
    ...overrides,
  };
}

function makeWO(type: WorkOrder['type'] = 'TRAINING'): WorkOrder {
  return {
    id: `wo_${type?.toLowerCase() ?? 'test'}`,
    title: `Test ${type}`,
    description: JSON.stringify({ domain: 'medical', datasetId: 'test', currentBestLoss: 0.5, maxTrainSeconds: 60 }),
    type,
    requiredCapabilities: ['cpu'],
    rewardAmount: '1000000000',
    status: 'PENDING',
    creatorAddress: 'creator',
    createdAt: Date.now(),
  };
}

function makeResearchWO(): WorkOrder {
  return {
    id: 'wo_research',
    title: 'BRCA1 Study',
    description: JSON.stringify({ title: 'BRCA1 Risk', abstract: 'BRCA1 variants increase breast cancer risk.' }),
    type: 'RESEARCH',
    requiredCapabilities: ['llm'],
    rewardAmount: '500000000',
    status: 'PENDING',
    creatorAddress: 'creator',
    createdAt: Date.now(),
  };
}

// ─── createInitialAgentState ─────────────────────────────────────────────────

describe('createInitialAgentState', () => {
  it('creates correct initial state', () => {
    const state = createInitialAgentState(TEST_CONFIG);
    expect(state.coordinatorUrl).toBe(TEST_CONFIG.coordinatorUrl);
    expect(state.peerId).toBe(TEST_CONFIG.peerId);
    expect(state.availableWorkOrders).toEqual([]);
    expect(state.submitted).toBe(false);
  });
});

// ─── EvaluateEconomicsNode ────────────────────────────────────────────────────

describe('EvaluateEconomicsNode', () => {
  const node = new EvaluateEconomicsNode();

  it('returns null when no selected WO', () => {
    const result = node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.economicEvaluation).toBeNull();
  });

  it('accepts training WO with ollama', () => {
    const result = node.execute(makeState({ selectedWorkOrder: makeWO('TRAINING') }));
    expect(result.economicEvaluation?.shouldAccept).toBe(true);
  });

  it('accepts research WO with ollama ($0 cost)', () => {
    const result = node.execute(makeState({ selectedWorkOrder: makeResearchWO() }));
    expect(result.economicEvaluation?.shouldAccept).toBe(true);
    expect(result.economicEvaluation?.estimatedCostUsd).toBe(0);
  });

  it('handles cloud model', () => {
    const cloudConfig = { ...TEST_CONFIG, llmModel: { provider: 'cloud' as const, modelId: 'gpt-4o-mini', providerId: 'openai-compat' as const } };
    const result = node.execute(makeState({ selectedWorkOrder: makeResearchWO(), config: cloudConfig }));
    expect(result.economicEvaluation).toBeDefined();
  });
});

// ─── FetchWorkOrdersNode ──────────────────────────────────────────────────────

describe('FetchWorkOrdersNode', () => {
  let node: FetchWorkOrdersNode;

  beforeEach(() => {
    jest.resetAllMocks();
    node = new FetchWorkOrdersNode();
    node.reset();
  });

  it('returns empty when coordinator returns empty', async () => {
    (fetchAvailableWorkOrders as any).mockResolvedValueOnce([]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('filters completed non-research WOs', async () => {
    const wo = makeWO('TRAINING');
    node.markCompleted(wo);
    (fetchAvailableWorkOrders as any).mockResolvedValueOnce([wo]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('filters research WOs on active cooldown', async () => {
    const wo = makeResearchWO();
    node.setResearchCooldown(wo.id);
    (fetchAvailableWorkOrders as any).mockResolvedValueOnce([wo]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('returns pending WOs when some filtered', async () => {
    const woT = makeWO('TRAINING');
    const woR = makeResearchWO();
    node.markCompleted(woT);
    (fetchAvailableWorkOrders as any).mockResolvedValueOnce([woT, woR]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toHaveLength(1);
    expect(result.availableWorkOrders?.[0].id).toBe(woR.id);
  });
});

// ─── ExecuteTrainingNode ─────────────────────────────────────────────────────

describe('ExecuteTrainingNode', () => {
  let node: ExecuteTrainingNode;
  beforeEach(() => { jest.resetAllMocks(); node = new ExecuteTrainingNode(); });

  it('calls executeTrainingWorkOrder with correct args', async () => {
    const wo = makeWO('TRAINING');
    (executeTrainingWorkOrder as any).mockResolvedValueOnce({ result: '{"valLoss":0.3}', success: true });
    const result = await node.execute(makeState({ selectedWorkOrder: wo }));
    expect(result.executionResult?.success).toBe(true);
    expect(executeTrainingWorkOrder).toHaveBeenCalledWith(wo, TEST_CONFIG.coordinatorUrl, TEST_CONFIG.peerId, TEST_CONFIG.capabilities, 1);
  });

  it('returns failure when throws', async () => {
    (executeTrainingWorkOrder as any).mockRejectedValueOnce(new Error('GPU OOM'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('TRAINING') }));
    expect(result.executionResult?.success).toBe(false);
  });
});

// ─── ExecuteInferenceNode ─────────────────────────────────────────────────────

describe('ExecuteInferenceNode', () => {
  let node: ExecuteInferenceNode;
  beforeEach(() => { jest.resetAllMocks(); node = new ExecuteInferenceNode(); });

  it('wraps inference result', async () => {
    (executeCpuInferenceWorkOrder as any).mockResolvedValueOnce({
      output: [0.1, 0.2], tokensProcessed: 5, latencyMs: 10, modelUsed: 'ollama/all-minilm',
    });
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('CPU_INFERENCE') }));
    expect(result.executionResult?.success).toBe(true);
  });

  it('returns failure when throws', async () => {
    (executeCpuInferenceWorkOrder as any).mockRejectedValueOnce(new Error('Ollama down'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('CPU_INFERENCE') }));
    expect(result.executionResult?.success).toBe(false);
  });
});

// ─── ExecuteDilocoNode ────────────────────────────────────────────────────────

describe('ExecuteDilocoNode', () => {
  let node: ExecuteDilocoNode;
  beforeEach(() => { jest.resetAllMocks(); node = new ExecuteDilocoNode(); });

  it('calls executeDiLoCoWorkOrder', async () => {
    const wo = makeWO('DILOCO_TRAINING');
    (executeDiLoCoWorkOrder as any).mockResolvedValueOnce({ result: '{"valLoss":0.25}', success: true });
    const result = await node.execute(makeState({ selectedWorkOrder: wo }));
    expect(result.executionResult?.success).toBe(true);
    expect(executeDiLoCoWorkOrder).toHaveBeenCalledWith(wo, TEST_CONFIG.coordinatorUrl, TEST_CONFIG.peerId, TEST_CONFIG.capabilities);
  });

  it('returns failure when throws', async () => {
    (executeDiLoCoWorkOrder as any).mockRejectedValueOnce(new Error('Gradient fail'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('DILOCO_TRAINING') }));
    expect(result.executionResult?.success).toBe(false);
  });
});

// ─── ExecuteResearchNode (mocked) ────────────────────────────────────────────

describe('ExecuteResearchNode (mocked)', () => {
  let node: ExecuteResearchNode;
  beforeEach(() => { jest.resetAllMocks(); node = new ExecuteResearchNode(); });

  it('returns success with research result', async () => {
    const mockResult = {
      summary: 'BRCA1 variants increase breast cancer risk.',
      keyInsights: ['k1', 'k2', 'k3'],
      proposal: 'Apply to federated networks.',
    };
    (executeResearchWorkOrder as any).mockResolvedValueOnce({
      result: mockResult, rawResponse: JSON.stringify(mockResult), success: true, hyperparams: null,
    });
    const result = await node.execute(makeState({ selectedWorkOrder: makeResearchWO() }));
    expect(result.executionResult?.success).toBe(true);
    expect(result.researchResult).toBeDefined();
  });

  it('returns failure on research error', async () => {
    (executeResearchWorkOrder as any).mockResolvedValueOnce({
      result: { summary: '', keyInsights: [], proposal: '' },
      rawResponse: 'error', success: false, hyperparams: null,
    });
    const result = await node.execute(makeState({ selectedWorkOrder: makeResearchWO() }));
    expect(result.executionResult?.success).toBe(false);
  });
});
