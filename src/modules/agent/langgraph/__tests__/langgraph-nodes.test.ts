/**
 * Unit tests for LangGraph node classes (NestJS injectable)
 * Sprint A - LangGraph Foundation
 */

import { jest } from '@jest/globals';

jest.mock('../../../../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(() => ({ valid: true })),
  calculateImprovement: jest.fn(() => 0),
}));

global.fetch = jest.fn() as unknown as typeof fetch;

import type { AgentState } from '../state';
import { SelectWorkOrderNode } from '../nodes/select-wo';
import { FetchWorkOrdersNode } from '../nodes/fetch-work-orders';
import { EvaluateEconomicsNode } from '../nodes/evaluate-economics';
import { AcceptWorkOrderNode } from '../nodes/accept-wo';
import { UpdateMemoryNode } from '../nodes/update-memory';
import { initBrain } from '../../agent-brain';
import type { WorkOrder } from '../../work-order-agent';

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
      peerId: 'peer1',
      capabilities: ['llm'],
      llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: undefined },
      intervalMs: 5000,
    },
    coordinatorUrl: 'http://localhost:3701',
    peerId: 'peer1',
    capabilities: ['llm'],
    ...overrides,
  };
}

const RESEARCH_WO: WorkOrder = {
  id: 'wo_1',
  title: 'BRCA1 Breast Cancer Risk',
  description: JSON.stringify({ title: 'BRCA1 Study', abstract: 'BRCA1 variants increase breast cancer risk.' }),
  type: 'RESEARCH',
  requiredCapabilities: ['llm'],
  rewardAmount: '1000000000',
  status: 'PENDING',
  creatorAddress: 'creator1',
  createdAt: Date.now(),
};

describe('SelectWorkOrderNode', () => {
  const node = new SelectWorkOrderNode();

  it('returns first available WO', () => {
    const result = node.execute(makeState({ availableWorkOrders: [RESEARCH_WO] }));
    expect(result.selectedWorkOrder?.id).toBe('wo_1');
  });

  it('returns null when no WOs', () => {
    const result = node.execute(makeState({ availableWorkOrders: [] }));
    expect(result.selectedWorkOrder).toBeNull();
  });
});

describe('FetchWorkOrdersNode', () => {
  let node: FetchWorkOrdersNode;

  beforeEach(() => {
    jest.resetAllMocks();
    node = new FetchWorkOrdersNode();
    node.reset();
  });

  it('returns empty array when coordinator returns empty', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: true, json: async () => [] });
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('returns work orders from coordinator', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: true, json: async () => [RESEARCH_WO] });
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toHaveLength(1);
  });

  it('filters completed non-research WOs', async () => {
    const trainingWO: WorkOrder = {
      ...RESEARCH_WO,
      id: 'wo_training',
      type: 'TRAINING',
      description: JSON.stringify({ domain: 'medical', datasetId: 'test', currentBestLoss: 0.5, maxTrainSeconds: 60 }),
    };
    node.markCompleted(trainingWO);
    (fetch as any).mockResolvedValueOnce({ ok: true, json: async () => [trainingWO] });
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('applies research cooldown', async () => {
    node.setResearchCooldown(RESEARCH_WO.id);
    (fetch as any).mockResolvedValueOnce({ ok: true, json: async () => [RESEARCH_WO] });
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });
});

describe('EvaluateEconomicsNode', () => {
  const node = new EvaluateEconomicsNode();

  it('returns null evaluation when no WO selected', () => {
    const result = node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.economicEvaluation).toBeNull();
  });

  it('evaluates WO with ollama model (always accept)', () => {
    const result = node.execute(makeState({ selectedWorkOrder: RESEARCH_WO }));
    expect(result.economicEvaluation).not.toBeNull();
    expect(result.economicEvaluation?.shouldAccept).toBe(true);
  });
});

describe('AcceptWorkOrderNode', () => {
  const node = new AcceptWorkOrderNode();

  beforeEach(() => jest.resetAllMocks());

  it('accepts work order successfully', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: true });
    const result = await node.execute(makeState({ selectedWorkOrder: RESEARCH_WO }));
    expect(result.accepted).toBe(true);
  });

  it('returns false when coordinator rejects', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: false, text: async () => 'error' });
    const result = await node.execute(makeState({ selectedWorkOrder: RESEARCH_WO }));
    expect(result.accepted).toBe(false);
  });

  it('returns false when no work order', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.accepted).toBe(false);
  });
});

describe('UpdateMemoryNode', () => {
  const node = new UpdateMemoryNode();

  it('returns brain unchanged when no research result', () => {
    const brain = initBrain();
    const result = node.execute(makeState({ brain, selectedWorkOrder: null }));
    expect(result.brain).toBeDefined();
  });
});
