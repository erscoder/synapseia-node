/**
 * Coverage tests - Part 2: executors, fetch, evaluate, state
 * Sprint A - LangGraph Foundation
 * Updated: uses Helper classes instead of deleted work-order-agent proxies
 */

import { jest } from '@jest/globals';

const mockExecuteTrainingWorkOrder = jest.fn<() => Promise<any>>();
const mockExecuteCpuInferenceWorkOrder = jest.fn<() => Promise<any>>();
const mockExecuteDiLoCoWorkOrder = jest.fn<() => Promise<any>>();
const mockExecuteResearchWorkOrder = jest.fn<() => Promise<any>>();
const mockExecuteDockingWorkOrder = jest.fn<() => Promise<any>>();
const mockExecuteLoraWorkOrder = jest.fn<() => Promise<any>>();
const mockExecuteLoraValidationWorkOrder = jest.fn<() => Promise<any>>();
const mockFetchAvailableWorkOrders = jest.fn<() => Promise<WorkOrder[]>>();
const mockScoreResearchResult = jest.fn<() => any>().mockReturnValue(0.85);
const mockIsResearchWorkOrder = jest.fn((wo: any) => wo?.type === 'RESEARCH');

jest.mock('../../../../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(() => ({ valid: true })),
  calculateImprovement: jest.fn(() => 0),
}));

// Training-LLM resolver — keep deterministic so tests don't depend on local
// Ollama. Returns the same model the CLI config passes in, so the existing
// `calls executeTrainingWorkOrder with correct args` assertion continues to
// match `TEST_CONFIG.llmModel`.
jest.mock('../../../../modules/llm/training-llm', () => ({
  resolveTrainingLlmModel: jest.fn(async () => ({
    provider: 'ollama', providerId: '', modelId: 'phi4-mini',
  })),
  resolveTrainingChain: jest.fn(async () => ({
    primary: { provider: 'ollama', providerId: '', modelId: 'phi4-mini' },
    fallbacks: [],
  })),
  isCapableTrainingModel: jest.fn(() => true),
}));

jest.mock('../../work-order/work-order.execution', () => ({
  WorkOrderExecutionHelper: jest.fn().mockImplementation(() => ({
    executeTrainingWorkOrder: mockExecuteTrainingWorkOrder,
    executeCpuInferenceWorkOrder: mockExecuteCpuInferenceWorkOrder,
    executeDiLoCoWorkOrder: mockExecuteDiLoCoWorkOrder,
    executeResearchWorkOrder: mockExecuteResearchWorkOrder,
    executeDockingWorkOrder: mockExecuteDockingWorkOrder,
    executeLoraWorkOrder: mockExecuteLoraWorkOrder,
    executeLoraValidationWorkOrder: mockExecuteLoraValidationWorkOrder,
    isResearchWorkOrder: mockIsResearchWorkOrder,
    isTrainingWorkOrder: jest.fn().mockReturnValue(false),
    isDiLoCoWorkOrder: jest.fn().mockReturnValue(false),
    isGpuInferenceWorkOrder: jest.fn().mockReturnValue(false),
  })),
}));
jest.mock('../../work-order/work-order.coordinator', () => ({
  WorkOrderCoordinatorHelper: jest.fn().mockImplementation(() => ({
    fetchAvailableWorkOrders: mockFetchAvailableWorkOrders,
  })),
}));
jest.mock('../../work-order/work-order.evaluation', () => ({
  WorkOrderEvaluationHelper: jest.fn().mockImplementation(() => ({
    scoreResearchResult: mockScoreResearchResult,
    loadEconomicConfig: jest.fn().mockReturnValue({
      llmType: 'ollama' as const,
      llmCostPer1kTokens: 0,
      synPriceUsd: 0.01,
      estimatedLatencyMs: 100,
    }),
    evaluateWorkOrder: jest.fn().mockImplementation((_wo: any, config: any) => ({
      bountyUsd: 1.0,
      estimatedCostUsd: config?.llmType === 'ollama' ? 0 : 0.01,
      shouldAccept: true,
      netValueUsd: 0.99,
      efficiencyScore: 99,
      profitRatio: 100,
      reason: 'profitable',
    })),
  })),
}));

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

// Get mocked helper classes
const { WorkOrderExecutionHelper } = require('../../work-order/work-order.execution');
const { WorkOrderEvaluationHelper } = require('../../work-order/work-order.evaluation');
const { WorkOrderCoordinatorHelper } = require('../../work-order/work-order.coordinator');
const coordinator = new WorkOrderCoordinatorHelper();
const evaluation = new WorkOrderEvaluationHelper();
const execution = new WorkOrderExecutionHelper(coordinator, evaluation);

jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

global.fetch = jest.fn() as unknown as typeof fetch;

import type { AgentState } from '../state';
import { createInitialAgentState } from '../state';
import { ExecuteTrainingNode } from '../nodes/execute-training';
import { ExecuteInferenceNode } from '../nodes/execute-inference';
import { ExecuteDilocoNode } from '../nodes/execute-diloco';
import { ExecuteResearchNode } from '../nodes/execute-research';
import { ExecuteDockingNode } from '../nodes/execute-docking';
import { ExecuteLoraNode } from '../nodes/execute-lora';
import { ExecuteLoraValidationNode } from '../nodes/execute-lora-validation';
import { UnknownTypeNode } from '../nodes/unknown-type';
import { FetchWorkOrdersNode } from '../nodes/fetch-work-orders';
import { EvaluateEconomicsNode } from '../nodes/evaluate-economics';
import { AgentBrainHelper } from '../../agent-brain';
import type { WorkOrder } from '../state';
import type { WorkOrderAgentConfig } from '../../work-order/work-order.types';

const TEST_CONFIG: WorkOrderAgentConfig = {
  coordinatorUrl: 'http://localhost:3701',
  peerId: 'test_peer',
  capabilities: ['llm'],
  llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: undefined },
  intervalMs: 5000,
};

const brainHelper = new AgentBrainHelper();

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
    brain: brainHelper.initBrain(),
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
  const node = new EvaluateEconomicsNode(evaluation);

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
    jest.clearAllMocks();
    mockIsResearchWorkOrder.mockImplementation((wo: any) => wo?.type === 'RESEARCH');
    const mockBackpressure = { canAccept: jest.fn().mockReturnValue(true), getInFlight: jest.fn().mockReturnValue(0), getMaxConcurrent: jest.fn().mockReturnValue(2), acquire: jest.fn().mockReturnValue(true), release: jest.fn() } as any;
    node = new FetchWorkOrdersNode(coordinator, execution, mockBackpressure);
    node.reset();
  });

  it('returns empty when coordinator returns empty', async () => {
    mockFetchAvailableWorkOrders.mockResolvedValueOnce([]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('filters completed non-research WOs', async () => {
    const wo = makeWO('TRAINING');
    node.markCompleted(wo);
    mockFetchAvailableWorkOrders.mockResolvedValueOnce([wo]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('filters research WOs on active cooldown', async () => {
    const wo = makeResearchWO();
    node.setResearchCooldown(wo.id);
    mockFetchAvailableWorkOrders.mockResolvedValueOnce([wo]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toEqual([]);
  });

  it('returns pending WOs when some filtered', async () => {
    const woT = makeWO('TRAINING');
    const woR = makeResearchWO();
    node.markCompleted(woT);
    mockFetchAvailableWorkOrders.mockResolvedValueOnce([woT, woR]);
    const result = await node.execute(makeState());
    expect(result.availableWorkOrders).toHaveLength(1);
    expect(result.availableWorkOrders?.[0].id).toBe(woR.id);
  });

  it('defers TRAINING / DILOCO WOs while chat inference is active, still serves RESEARCH', async () => {
    const {
      beginChatInference,
      endChatInference,
      _resetChatInferenceStateForTests,
    } = require('../../../inference/chat-inference-state');
    _resetChatInferenceStateForTests();
    // The module-level `execution` instance already exposes the jest.mock'd
    // methods; override them per-test instead of reaching into mock.results.
    (execution as any).isTrainingWorkOrder = jest.fn((wo: any) => wo?.type === 'TRAINING');
    (execution as any).isDiLoCoWorkOrder = jest.fn((wo: any) => wo?.type === 'DILOCO_TRAINING');

    // Training/DILOCO WOs must pass the capability guard so the test actually
    // exercises the chat mutex path (not the unrelated cap-filter path).
    const woTrain = { ...makeWO('TRAINING'), requiredCapabilities: ['llm'] };
    const woDiloco = { ...makeWO('DILOCO_TRAINING'), requiredCapabilities: ['llm'] };
    const woResearch = makeResearchWO();
    mockFetchAvailableWorkOrders.mockResolvedValueOnce([woTrain, woDiloco, woResearch]);

    beginChatInference();
    try {
      const result = await node.execute(makeState());
      expect(result.availableWorkOrders).toHaveLength(1);
      expect(result.availableWorkOrders?.[0].id).toBe(woResearch.id);
    } finally {
      endChatInference();
      (execution as any).isTrainingWorkOrder = jest.fn().mockReturnValue(false);
      (execution as any).isDiLoCoWorkOrder = jest.fn().mockReturnValue(false);
    }
  });

  it('serves TRAINING WOs again once chat inference ends', async () => {
    const {
      beginChatInference,
      endChatInference,
      _resetChatInferenceStateForTests,
    } = require('../../../inference/chat-inference-state');
    _resetChatInferenceStateForTests();
    (execution as any).isTrainingWorkOrder = jest.fn((wo: any) => wo?.type === 'TRAINING');

    const woTrain = { ...makeWO('TRAINING'), requiredCapabilities: ['llm'] };
    beginChatInference();
    endChatInference();
    mockFetchAvailableWorkOrders.mockResolvedValueOnce([woTrain]);
    try {
      const result = await node.execute(makeState());
      expect(result.availableWorkOrders).toHaveLength(1);
      expect(result.availableWorkOrders?.[0].id).toBe(woTrain.id);
    } finally {
      (execution as any).isTrainingWorkOrder = jest.fn().mockReturnValue(false);
    }
  });
});

// ─── ExecuteTrainingNode ─────────────────────────────────────────────────────

describe('ExecuteTrainingNode', () => {
  let node: ExecuteTrainingNode;
  beforeEach(() => { jest.clearAllMocks(); node = new ExecuteTrainingNode(execution); });

  it('calls executeTrainingWorkOrder with resolver-chosen model (not config.llmModel)', async () => {
    const wo = makeWO('TRAINING');
    mockExecuteTrainingWorkOrder.mockResolvedValueOnce({ result: '{"valLoss":0.3}', success: true });
    const result = await node.execute(makeState({ selectedWorkOrder: wo }));
    expect(result.executionResult?.success).toBe(true);
    // The training node now resolves a capable model via resolveTrainingLlmModel
    // (mocked to phi4-mini here) instead of trusting config.llmModel which is
    // typically the inference-sized CLI flag.
    expect(mockExecuteTrainingWorkOrder).toHaveBeenCalledWith(
      wo,
      TEST_CONFIG.coordinatorUrl,
      TEST_CONFIG.peerId,
      TEST_CONFIG.capabilities,
      1,
      { provider: 'ollama', providerId: '', modelId: 'phi4-mini' },
      TEST_CONFIG.llmConfig,
      [],
    );
  });

  it('returns failure when throws', async () => {
    mockExecuteTrainingWorkOrder.mockRejectedValueOnce(new Error('GPU OOM'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('TRAINING') }));
    expect(result.executionResult?.success).toBe(false);
  });
});

// ─── ExecuteInferenceNode ─────────────────────────────────────────────────────

describe('ExecuteInferenceNode', () => {
  let node: ExecuteInferenceNode;
  beforeEach(() => { jest.clearAllMocks(); node = new ExecuteInferenceNode(execution); });

  it('wraps inference result', async () => {
    mockExecuteCpuInferenceWorkOrder.mockResolvedValueOnce({
      output: [0.1, 0.2], tokensProcessed: 5, latencyMs: 10, modelUsed: 'ollama/all-minilm',
    });
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('CPU_INFERENCE') }));
    expect(result.executionResult?.success).toBe(true);
  });

  it('returns failure when throws', async () => {
    mockExecuteCpuInferenceWorkOrder.mockRejectedValueOnce(new Error('Ollama down'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('CPU_INFERENCE') }));
    expect(result.executionResult?.success).toBe(false);
  });
});

// ─── ExecuteDilocoNode ────────────────────────────────────────────────────────

describe('ExecuteDilocoNode', () => {
  let node: ExecuteDilocoNode;
  beforeEach(() => { jest.clearAllMocks(); node = new ExecuteDilocoNode(execution); });

  it('calls executeDiLoCoWorkOrder', async () => {
    const wo = makeWO('DILOCO_TRAINING');
    mockExecuteDiLoCoWorkOrder.mockResolvedValueOnce({ result: '{"valLoss":0.25}', success: true });
    const result = await node.execute(makeState({ selectedWorkOrder: wo }));
    expect(result.executionResult?.success).toBe(true);
    expect(mockExecuteDiLoCoWorkOrder).toHaveBeenCalledWith(wo, TEST_CONFIG.coordinatorUrl, TEST_CONFIG.peerId, TEST_CONFIG.capabilities);
  });

  it('returns failure when throws', async () => {
    mockExecuteDiLoCoWorkOrder.mockRejectedValueOnce(new Error('Gradient fail'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('DILOCO_TRAINING') }));
    expect(result.executionResult?.success).toBe(false);
  });
});

// ─── ExecuteResearchNode ─────────────────────────────────────────────────────────

describe('ExecuteResearchNode', () => {
  let node: ExecuteResearchNode;

  beforeEach(() => {
    jest.clearAllMocks();
    // Get the module-level mocked instances
    const mockExec = new WorkOrderExecutionHelper();
    const mockEval = new WorkOrderEvaluationHelper();
    // Import mocked tool classes
    const { ToolRunnerService } = require('../tools/tool-runner.service');
    const { ToolRegistry } = require('../tools/tool-registry');
    const { LangGraphLlmService } = require('../llm.service');
    node = new ExecuteResearchNode(
      mockExec as any,
      mockEval as any,
      new ToolRunnerService(null, null, null),
      new ToolRegistry(),
      new LangGraphLlmService(null),
    );
  });

  it('returns failure when no work order selected', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toContain('No work order selected');
  });


});

// ─── ExecuteDockingNode ──────────────────────────────────────────────────────

describe('ExecuteDockingNode', () => {
  let node: ExecuteDockingNode;
  beforeEach(() => { jest.clearAllMocks(); node = new ExecuteDockingNode(execution); });

  it('returns failure when no work order selected', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toContain('No work order selected');
  });

  it('wraps successful docking result', async () => {
    const wo = makeWO('MOLECULAR_DOCKING');
    mockExecuteDockingWorkOrder.mockResolvedValueOnce({
      result: JSON.stringify({ bestAffinity: -8.4, poses: [] }),
      success: true,
    });
    const result = await node.execute(makeState({ selectedWorkOrder: wo, peerId: 'peer123' }));
    expect(result.executionResult?.success).toBe(true);
    expect(mockExecuteDockingWorkOrder).toHaveBeenCalledWith(wo, 'peer123');
  });

  it('propagates failure from executeDockingWorkOrder', async () => {
    mockExecuteDockingWorkOrder.mockResolvedValueOnce({ result: 'Docking failed [VINA]', success: false });
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('MOLECULAR_DOCKING') }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toContain('Docking failed');
  });

  it('catches thrown errors', async () => {
    mockExecuteDockingWorkOrder.mockRejectedValueOnce(new Error('Vina crashed'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('MOLECULAR_DOCKING') }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toContain('Vina crashed');
  });
});

// ─── ExecuteLoraNode ─────────────────────────────────────────────────────────

describe('ExecuteLoraNode', () => {
  let node: ExecuteLoraNode;
  beforeEach(() => { jest.clearAllMocks(); node = new ExecuteLoraNode(execution); });

  it('returns failure when no work order selected', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('wraps successful LoRA training result', async () => {
    const wo = makeWO('LORA_TRAINING');
    mockExecuteLoraWorkOrder.mockResolvedValueOnce({
      result: JSON.stringify({ adapterId: 'a1', reportedValMetrics: { f1: 0.87 } }),
      success: true,
    });
    const result = await node.execute(makeState({ selectedWorkOrder: wo, peerId: 'peer123' }));
    expect(result.executionResult?.success).toBe(true);
    expect(mockExecuteLoraWorkOrder).toHaveBeenCalledWith(wo, 'peer123');
  });

  it('propagates failure from executeLoraWorkOrder', async () => {
    mockExecuteLoraWorkOrder.mockResolvedValueOnce({ result: 'LoRA training failed [UPLOAD]', success: false });
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('LORA_TRAINING') }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('catches thrown errors', async () => {
    mockExecuteLoraWorkOrder.mockRejectedValueOnce(new Error('Python OOM'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('LORA_TRAINING') }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toContain('Python OOM');
  });
});

// ─── ExecuteLoraValidationNode ──────────────────────────────────────────────

describe('ExecuteLoraValidationNode', () => {
  let node: ExecuteLoraValidationNode;
  const origFlag = process.env.LORA_VALIDATOR_ENABLED;
  beforeEach(() => { jest.clearAllMocks(); node = new ExecuteLoraValidationNode(execution); });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.LORA_VALIDATOR_ENABLED;
    else process.env.LORA_VALIDATOR_ENABLED = origFlag;
  });

  it('returns failure when no work order selected', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('refuses to execute when LORA_VALIDATOR_ENABLED is not true (default OFF)', async () => {
    delete process.env.LORA_VALIDATOR_ENABLED;
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('LORA_VALIDATION') }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toContain('lora validator disabled');
    expect(mockExecuteLoraValidationWorkOrder).not.toHaveBeenCalled();
  });

  it('wraps successful LoRA validation result when opt-in flag is set', async () => {
    process.env.LORA_VALIDATOR_ENABLED = 'true';
    const wo = makeWO('LORA_VALIDATION');
    mockExecuteLoraValidationWorkOrder.mockResolvedValueOnce({
      result: JSON.stringify({ adapterId: 'a1', observed: { f1: 0.85 } }),
      success: true,
    });
    const result = await node.execute(makeState({ selectedWorkOrder: wo, peerId: 'peer123' }));
    expect(result.executionResult?.success).toBe(true);
    expect(mockExecuteLoraValidationWorkOrder).toHaveBeenCalledWith(wo, 'peer123');
  });

  it('catches thrown errors when enabled', async () => {
    process.env.LORA_VALIDATOR_ENABLED = 'true';
    mockExecuteLoraValidationWorkOrder.mockRejectedValueOnce(new Error('Eval crashed'));
    const result = await node.execute(makeState({ selectedWorkOrder: makeWO('LORA_VALIDATION') }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toContain('Eval crashed');
  });
});

// ─── UnknownTypeNode ─────────────────────────────────────────────────────────

describe('UnknownTypeNode', () => {
  let node: UnknownTypeNode;
  const logger = require('../../../../utils/logger').default;
  beforeEach(() => { jest.clearAllMocks(); node = new UnknownTypeNode(); });

  it('returns failure when no work order selected', async () => {
    const result = await node.execute(makeState({ selectedWorkOrder: null }));
    expect(result.executionResult?.success).toBe(false);
  });

  it('returns success=false and logs warn for unknown WO type', async () => {
    const wo = { ...makeWO('TRAINING'), type: 'TOTALLY_NEW_TYPE' as any };
    const result = await node.execute(makeState({ selectedWorkOrder: wo }));
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toBe('unknown WO type');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown WO type=TOTALLY_NEW_TYPE'),
    );
  });
});

// ─── router exhaustiveness over all WorkOrderType ───────────────────────────

describe('router — exhaustiveness over all WorkOrderType', () => {
  // Inline routing function — mirrors the switch in
  // `agent-graph.service.ts:buildGraph()`. If the production switch
  // changes, this test must change too (compile-time `never` guard
  // backs this up at build time).
  function route(t: WorkOrder['type']): string {
    switch (t) {
      case 'RESEARCH':          return 'researcher';
      case 'TRAINING':          return 'executeTraining';
      case 'CPU_INFERENCE':     return 'executeInference';
      case 'GPU_INFERENCE':     return 'executeInference';
      case 'DILOCO_TRAINING':   return 'executeDiloco';
      case 'MOLECULAR_DOCKING': return 'executeDocking';
      case 'LORA_TRAINING':     return 'executeLora';
      case 'LORA_VALIDATION':   return 'executeLoraValidation';
      case 'INFERENCE':         return 'unknownType';
      case 'COMPUTATION':       return 'unknownType';
      case 'DATA_PROCESSING':   return 'unknownType';
      case undefined:           return 'unknownType';
      default: {
        const _exhaustive: never = t;
        void _exhaustive;
        return 'unknownType';
      }
    }
  }

  it.each<[NonNullable<WorkOrder['type']>, string]>([
    ['RESEARCH', 'researcher'],
    ['TRAINING', 'executeTraining'],
    ['CPU_INFERENCE', 'executeInference'],
    ['GPU_INFERENCE', 'executeInference'],
    ['DILOCO_TRAINING', 'executeDiloco'],
    ['MOLECULAR_DOCKING', 'executeDocking'],
    ['LORA_TRAINING', 'executeLora'],
    ['LORA_VALIDATION', 'executeLoraValidation'],
  ])('%s routes to %s', (type, expected) => {
    expect(route(type)).toBe(expected);
  });

  it('unknown / undefined type routes to unknownType (fail-loud)', () => {
    expect(route(undefined)).toBe('unknownType');
  });

  it('legacy non-langgraph types route to unknownType', () => {
    expect(route('INFERENCE')).toBe('unknownType');
    expect(route('COMPUTATION')).toBe('unknownType');
    expect(route('DATA_PROCESSING')).toBe('unknownType');
  });
});
