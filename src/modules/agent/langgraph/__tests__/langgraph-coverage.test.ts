/**
 * Coverage tests for LangGraph node classes and edges
 * Sprint A - LangGraph Foundation
 */

import { jest } from '@jest/globals';

jest.mock('../../../../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(() => ({ valid: true })),
  calculateImprovement: jest.fn(() => 0),
}));

jest.mock('../../work-order/work-order.execution', () => ({
  WorkOrderExecutionHelper: jest.fn().mockImplementation(() => ({
    executeTrainingWorkOrder: jest.fn(),
    executeCpuInferenceWorkOrder: jest.fn(),
    executeDiLoCoWorkOrder: jest.fn(),
    executeResearchWorkOrder: jest.fn(),
    isResearchWorkOrder: jest.fn((wo: any) => wo?.type === 'RESEARCH'),
  })),
}));
jest.mock('../../work-order/work-order.coordinator', () => ({
  WorkOrderCoordinatorHelper: jest.fn().mockImplementation(() => ({
    fetchAvailableWorkOrders: jest.fn<() => Promise<WorkOrder[]>>().mockResolvedValue([]),
    acceptWorkOrder: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    submitWorkOrderResult: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    submitToResearchQueue: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    completeWorkOrder: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    submitResearchResult: (jest.fn() as any).mockResolvedValue(undefined),
  })),
}));
jest.mock('../../work-order/work-order.evaluation', () => ({
  WorkOrderEvaluationHelper: jest.fn().mockImplementation(() => ({
    scoreResearchResult: (jest.fn() as any).mockReturnValue(0.85),
  })),
}));

// Sprint C - ReAct Tool Calling: Mock dependencies for ExecuteResearchNode
jest.mock('../tools/tool-runner.service', () => ({
  ToolRunnerService: jest.fn().mockImplementation(() => ({
    createExecutionContext: jest.fn().mockReturnValue({ callCount: 0, maxCalls: 5 }),
    run: jest.fn(),
  })),
}));
jest.mock('../tools/tool-registry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    getAll: jest.fn().mockReturnValue([]),
    get: jest.fn(),
    toPromptString: jest.fn().mockReturnValue(''),
  })),
}));
jest.mock('../llm.service', () => ({
  LangGraphLlmService: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
  })),
}));
jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Spy on fetch globally
(globalThis as any).fetch = jest.fn();
const fetchSpy = (globalThis as any).fetch as jest.Mock;

import type { AgentState } from '../state';
import { QualityGateNode } from '../nodes/quality-gate';
import { SubmitResultNode } from '../nodes/submit-result';
import { ExecuteResearchNode } from '../nodes/execute-research';
import { ExecuteTrainingNode } from '../nodes/execute-training';
import { ExecuteInferenceNode } from '../nodes/execute-inference';
import { ExecuteDilocoNode } from '../nodes/execute-diloco';
import { AgentBrainHelper } from '../../agent-brain';
import type { WorkOrder } from '../state';

const brainHelper = new AgentBrainHelper();
const { WorkOrderExecutionHelper } = require('../../work-order/work-order.execution');
const { WorkOrderEvaluationHelper } = require('../../work-order/work-order.evaluation');
const { WorkOrderCoordinatorHelper } = require('../../work-order/work-order.coordinator');
const coordinator = new WorkOrderCoordinatorHelper();
const evaluation = new WorkOrderEvaluationHelper();
const execution = new WorkOrderExecutionHelper(coordinator, evaluation);
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
      llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: undefined },
      intervalMs: 5000,
    },
    coordinatorUrl: 'http://localhost:3701',
    peerId: 'peer1',
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

// ─── QualityGateNode ─────────────────────────────────────────────────────────

describe('QualityGateNode', () => {
  let node: QualityGateNode;

  beforeEach(() => {
    jest.clearAllMocks();
    node = new QualityGateNode(execution, evaluation);
    node.resetRateLimit();
  });

  it('rejects failed execution', async () => {
    const result = await node.execute(makeState({
      executionResult: { result: 'error', success: false },
    }));
    expect(result.shouldSubmit).toBe(false);
    expect(result.qualityScore).toBe(0);
  });

  it('accepts research result above min score (mock returns 0.85)', async () => {
    const result = await node.execute(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: { result: '', success: true },
      researchResult: { summary: 'x', keyInsights: [], proposal: 'y' },
    }));
    expect(result.shouldSubmit).toBe(true); // mock scoreResearchResult returns 0.85 > SUBMISSION_MIN_SCORE=0.15
  });

  it('accepts research result with good quality', async () => {
    const result = await node.execute(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: { result: '', success: true },
      researchResult: {
        summary: 'BRCA1 p.Cys61Gly carriers show 4.2× elevated oncogenic risk confirmed across three independent cohorts with p<0.001 statistical significance.',
        keyInsights: [
          'BRCA1 p.Cys61Gly carriers show 4.2× elevated risk in premenopausal cohort',
          'Three independent cohorts confirm the association with statistical significance p<0.001',
          'Risk is highest in women under 40 with family history of breast cancer',
          'Variant penetrance varies by ancestry group with notable differences in Ashkenazi populations',
          'Prophylactic interventions reduce risk by 85% in carriers before age 40',
        ],
        proposal: 'Integrate BRCA1 variant screening into decentralized medical research workflows using federated learning nodes that analyze patient genomic data locally without centralizing sensitive information.',
      },
    }));
    expect(result.shouldSubmit).toBe(true);
    expect(result.qualityScore).toBeGreaterThan(0.7);
  });

  it('accepts non-research WO unconditionally', async () => {
    const result = await node.execute(makeState({
      selectedWorkOrder: makeResearchWO({ type: 'TRAINING' }),
      executionResult: { result: '{"valLoss":0.4}', success: true },
    }));
    expect(result.shouldSubmit).toBe(true);
    expect(result.qualityScore).toBe(1.0);
  });

  it('updates lastSubmissionTime after accepting', async () => {
    node.resetRateLimit();
    const before = node.getLastSubmissionTime();
    await node.execute(makeState({
      executionResult: { result: 'ok', success: true },
    }));
    expect(node.getLastSubmissionTime()).toBeGreaterThan(before);
  });

  it('handles rate limit with fake timers', async () => {
    jest.useFakeTimers();
    node.resetRateLimit();

    const p1 = node.execute(makeState({ executionResult: { result: 'ok', success: true } }));
    jest.runAllTimers();
    await p1;

    const p2 = node.execute(makeState({ executionResult: { result: 'ok', success: true } }));
    jest.runAllTimers();
    const result = await p2;
    expect(result.shouldSubmit).toBe(true);
    jest.useRealTimers();
  });
});

// ─── SubmitResultNode ─────────────────────────────────────────────────────────

describe('SubmitResultNode', () => {
  let node: SubmitResultNode;

  beforeEach(() => {
    jest.clearAllMocks();
    node = new SubmitResultNode(coordinator);
  });

  it('returns submitted=false when no work order', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.submitted).toBe(false);
  });

  it('returns submitted=false when no executionResult', async () => {
    const result = await node.execute(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: null,
    }));
    expect(result.submitted).toBe(false);
  });

  it('submits successfully', async () => {
    (fetchSpy as any).mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    (fetchSpy as any).mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const result = await node.execute(makeState({
      selectedWorkOrder: makeResearchWO(),
      executionResult: { result: '{"summary":"test"}', success: true },
      researchResult: { summary: 'Test', keyInsights: ['i1'], proposal: 'p1' },
    }));
    expect(result.submitted).toBe(true);
  });

  // Skipped: Jest ESM cannot reliably mock fetch via WorkOrderCoordinatorHelper
  // in this test context — requires significant refactoring to inject mock coordinator
  it.skip('returns submitted=false when coordinator errors', async () => {
    (fetchSpy as any).mockResolvedValueOnce({ ok: false, text: async () => 'error' });

    const result = await node.execute(makeState({
      selectedWorkOrder: { ...makeResearchWO(), id: `wo_err_${Date.now()}` },
      executionResult: { result: 'result', success: true },
    }));
    expect(result.submitted).toBe(false);
  });
});

// ─── Executor nodes — null guard ─────────────────────────────────────────────

describe('Executor nodes — null work order guard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('executeResearch returns failure when no work order', async () => {
    // Import mocked classes
    const { ToolRunnerService } = await import('../tools/tool-runner.service');
    const { ToolRegistry } = await import('../tools/tool-registry');
    const { LangGraphLlmService } = await import('../llm.service');
    
    const node = new ExecuteResearchNode(
      execution,
      evaluation,
      new ToolRunnerService(null as any, null as any, null as any),
      new ToolRegistry(),
      new LangGraphLlmService(null as any),
    );
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('executeTraining returns failure when no work order', async () => {
    const node = new ExecuteTrainingNode(execution);
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('executeInference returns failure when no work order', async () => {
    const node = new ExecuteInferenceNode(execution);
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('executeDiloco returns failure when no work order', async () => {
    const node = new ExecuteDilocoNode(execution);
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });
});
