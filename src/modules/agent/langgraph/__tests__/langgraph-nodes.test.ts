/**
 * Unit tests for LangGraph node classes
 * Sprint A - LangGraph Foundation
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mock modules ─────────────────────────────────────────────────────────────

jest.mock('../../../../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(() => ({ valid: true })),
  calculateImprovement: jest.fn(() => 0),
}));

jest.mock('../../work-order/work-order.execution', () => ({
  WorkOrderExecutionHelper: jest.fn().mockImplementation(() => ({
    isResearchWorkOrder: jest.fn((wo: any) => wo?.type === 'RESEARCH'),
    isTrainingWorkOrder: jest.fn((wo: any) => wo?.type === 'TRAINING'),
    isDiLoCoWorkOrder: jest.fn((wo: any) => wo?.type === 'DILOCO_TRAINING'),
  })),
}));

jest.mock('../../work-order/work-order.coordinator', () => ({
  WorkOrderCoordinatorHelper: jest.fn().mockImplementation(() => ({
    fetchAvailableWorkOrders: jest.fn<() => Promise<WorkOrder[]>>().mockResolvedValue([]),
    acceptWorkOrder: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    completeWorkOrder: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    submitWorkOrderResult: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    submitToResearchQueue: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../work-order/work-order.evaluation', () => ({
  WorkOrderEvaluationHelper: jest.fn().mockImplementation(() => ({
    scoreResearchResult: jest.fn().mockReturnValue(0.85),
    loadEconomicConfig: jest.fn().mockReturnValue({
      llmCostPer1kTokens: 0,
      synPriceUsd: 0.01,
      estimatedLatencyMs: 100,
    }),
    evaluateWorkOrder: jest.fn().mockReturnValue({
      bountyUsd: 1.0,
      estimatedCostUsd: 0.01,
      shouldAccept: true,
      netValueUsd: 0.99,
      efficiencyScore: 99,
      profitRatio: 100,
      reason: 'profitable',
    }),
  })),
}));

jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

(global.fetch as jest.Mock) = jest.fn();

// ── Imports (after mocks) ───────────────────────────────────────────────────

import type { AgentState, WorkOrder } from '../state';
import { SelectWorkOrderNode } from '../nodes/select-wo';
import { FetchWorkOrdersNode } from '../nodes/fetch-work-orders';
import { EvaluateEconomicsNode } from '../nodes/evaluate-economics';
import { AcceptWorkOrderNode } from '../nodes/accept-wo';
import { UpdateMemoryNode } from '../nodes/update-memory';
import { AgentBrainHelper } from '../../agent-brain';

// Mocked helpers (constructed after jest.mock calls above)
const { WorkOrderCoordinatorHelper } = require('../../work-order/work-order.coordinator');
const { WorkOrderEvaluationHelper } = require('../../work-order/work-order.evaluation');
const { WorkOrderExecutionHelper } = require('../../work-order/work-order.execution');

// ── Helpers ─────────────────────────────────────────────────────────────────

const coordinator = new WorkOrderCoordinatorHelper();
const evaluation = new WorkOrderEvaluationHelper();
const execution = new WorkOrderExecutionHelper(coordinator, evaluation);
const brainHelper = new AgentBrainHelper();
const initBrain = () => brainHelper.initBrain();

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
      llmModel: { provider: 'ollama', modelId: 'phi4-mini', providerId: '' },
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
    // Don't use jest.resetAllMocks() here — we inject mock objects directly
    // and don't rely on module-level mocks
    node = new FetchWorkOrdersNode(coordinator, execution);
    node.reset();
  });

  it('returns empty array when coordinator returns empty', async () => {
    // Replace the coordinator instance with a fully controlled mock
    const mockCoordinator = {
      fetchAvailableWorkOrders: jest.fn<() => Promise<WorkOrder[]>>().mockResolvedValue([]),
    };
    (node as any).coordinator = mockCoordinator;
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('returns work orders from coordinator', async () => {
    const mockCoordinator = {
      fetchAvailableWorkOrders: jest.fn<() => Promise<WorkOrder[]>>().mockResolvedValue([RESEARCH_WO]),
    };
    const mockExecution = {
      isResearchWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'RESEARCH'),
      isTrainingWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'TRAINING'),
      isDiLoCoWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'DILOCO_TRAINING'),
    };
    (node as any).coordinator = mockCoordinator;
    (node as any).execution = mockExecution;
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
    const mockCoordinator = {
      fetchAvailableWorkOrders: jest.fn<() => Promise<WorkOrder[]>>().mockResolvedValue([trainingWO]),
    };
    const mockExecution = {
      isResearchWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'RESEARCH'),
      isTrainingWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'TRAINING'),
      isDiLoCoWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'DILOCO_TRAINING'),
    };
    (node as any).coordinator = mockCoordinator;
    (node as any).execution = mockExecution;
    node.markCompleted(trainingWO);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('applies research cooldown', async () => {
    const mockCoordinator = {
      fetchAvailableWorkOrders: jest.fn<() => Promise<WorkOrder[]>>().mockResolvedValue([RESEARCH_WO]),
    };
    const mockExecution = {
      isResearchWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'RESEARCH'),
      isTrainingWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'TRAINING'),
      isDiLoCoWorkOrder: jest.fn((wo: WorkOrder) => wo.type === 'DILOCO_TRAINING'),
    };
    (node as any).coordinator = mockCoordinator;
    (node as any).execution = mockExecution;
    node.setResearchCooldown(RESEARCH_WO.id);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });
});

describe('EvaluateEconomicsNode', () => {
  const node = new EvaluateEconomicsNode(evaluation);
  // Note: No beforeEach — WorkOrderEvaluationHelper mock is set up at module level and should not be reset

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
  let node: AcceptWorkOrderNode;

  beforeEach(() => {
    jest.resetAllMocks();
    node = new AcceptWorkOrderNode(coordinator);
    // Inject mock coordinator to bypass fetch
    const mockCoordinator = {
      acceptWorkOrder: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    };
    (node as any).coordinator = mockCoordinator;
  });

  it('accepts work order successfully', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: RESEARCH_WO }));
    expect(result.accepted).toBe(true);
  });

  it('returns false when coordinator rejects', async () => {
    (node as any).coordinator.acceptWorkOrder = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const result = await node.execute(makeState({ selectedWorkOrder: RESEARCH_WO }));
    expect(result.accepted).toBe(false);
  });

  it('returns false when no work order', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.accepted).toBe(false);
  });
});

describe('UpdateMemoryNode', () => {
  const node = new UpdateMemoryNode(execution, brainHelper);

  it('returns brain unchanged when no research result', () => {
    const brain = initBrain();
    const result = node.execute(makeState({ brain, selectedWorkOrder: null }));
    expect(result.brain).toBeDefined();
  });
});
