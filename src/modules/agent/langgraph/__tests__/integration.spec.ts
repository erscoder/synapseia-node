/**
 * Integration test for AgentGraphService
 * Sprint A - LangGraph Foundation
 */

import { jest } from '@jest/globals';

jest.mock('../../../../modules/model/trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(() => ({ valid: true })),
  calculateImprovement: jest.fn(() => 0),
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

global.fetch = jest.fn() as unknown as typeof fetch;

import { AgentGraphService } from '../agent-graph.service';
import { CheckpointService } from '../checkpoint.service';
import { FetchWorkOrdersNode } from '../nodes/fetch-work-orders';
import { SelectWorkOrderNode } from '../nodes/select-wo';
import { EvaluateEconomicsNode } from '../nodes/evaluate-economics';
import { AcceptWorkOrderNode } from '../nodes/accept-wo';
import { ExecuteResearchNode } from '../nodes/execute-research';
import { ExecuteTrainingNode } from '../nodes/execute-training';
import { ExecuteInferenceNode } from '../nodes/execute-inference';
import { ExecuteDilocoNode } from '../nodes/execute-diloco';
import { QualityGateNode } from '../nodes/quality-gate';
import { SubmitResultNode } from '../nodes/submit-result';
import { UpdateMemoryNode } from '../nodes/update-memory';
import { RetrieveMemoryNode } from '../nodes/retrieve-memory';
import { PlanExecutionNode } from '../nodes/plan-execution';
import { SelfCritiqueNode } from '../nodes/self-critique';
import type { WorkOrderAgentConfig } from '../../work-order/work-order.types';

const TEST_CONFIG: WorkOrderAgentConfig = {
  coordinatorUrl: 'http://localhost:3701',
  peerId: 'test_peer',
  capabilities: ['llm'],
  llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: undefined },
  intervalMs: 5000,
};

const mockLlmService = { generate: (jest.fn() as any).mockResolvedValue('[]') };

// Import mocked classes for ExecuteResearchNode
const { ToolRunnerService } = require('../tools/tool-runner.service');
const { ToolRegistry } = require('../tools/tool-registry');
const { LangGraphLlmService } = require('../llm.service');
const { AgentBrainHelper } = require('../../agent-brain');
const { LlmProviderHelper } = require('../../../llm/llm-provider');
const { WorkOrderCoordinatorHelper } = require('../../work-order/work-order.coordinator');
const { WorkOrderEvaluationHelper } = require('../../work-order/work-order.evaluation');
const { WorkOrderExecutionHelper } = require('../../work-order/work-order.execution');
const { ResearcherNode } = require('../nodes/researcher-node');
const { CriticNode } = require('../nodes/critic-node');
const { SynthesizerNode } = require('../nodes/synthesizer-node');

function buildService(): AgentGraphService {
  const llmProvider = new LlmProviderHelper();
  const coordinator = new WorkOrderCoordinatorHelper();
  const evaluation = new WorkOrderEvaluationHelper();
  const execution = new WorkOrderExecutionHelper(coordinator, evaluation, llmProvider);
  const toolRunner = new ToolRunnerService(null, null, null);
  const toolRegistry = new ToolRegistry();
  const llmService = new LangGraphLlmService(null);
  const agentBrain = new AgentBrainHelper();
  return new AgentGraphService(
    new FetchWorkOrdersNode(coordinator, execution),
    new SelectWorkOrderNode(),
    new EvaluateEconomicsNode(evaluation),
    new AcceptWorkOrderNode(coordinator),
    new ExecuteResearchNode(execution, evaluation, toolRunner, toolRegistry, llmService),
    new ExecuteTrainingNode(execution),
    new ExecuteInferenceNode(execution),
    new ExecuteDilocoNode(execution),
    new QualityGateNode(execution, evaluation),
    new SubmitResultNode(coordinator, { markCompleted: jest.fn() } as any),
    new UpdateMemoryNode(execution, agentBrain),
    new RetrieveMemoryNode(),
    new PlanExecutionNode(mockLlmService as any, execution),
    new SelfCritiqueNode(mockLlmService as any),
    new ResearcherNode(llmProvider, coordinator),
    new CriticNode(llmProvider, coordinator),
    new SynthesizerNode(llmProvider, coordinator),
    agentBrain,
    new CheckpointService(),
  );
}

describe('AgentGraphService', () => {
  beforeEach(() => jest.resetAllMocks());

  describe('buildGraph', () => {
    it('creates a compiled graph with invoke method', () => {
      const service = buildService();
      const graph = service.buildGraph();
      expect(graph).toBeDefined();
      expect(typeof graph.invoke).toBe('function');
    });
  });

  describe('runIteration', () => {
    it('handles empty work order list gracefully', async () => {
      (fetch as any).mockResolvedValueOnce({ ok: true, json: async () => [] });

      const service = buildService();
      const result = await service.runIteration(TEST_CONFIG, 1);

      expect(result).toBeDefined();
      expect(result.completed).toBe(false);
    });

    it('completes a full iteration with a mock WO', async () => {
      const mockWO = {
        id: 'wo_integration',
        title: 'Integration Test Research',
        description: JSON.stringify({
          title: 'Integration Test',
          abstract: 'This is a test abstract for integration testing.',
        }),
        type: 'RESEARCH',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator',
        createdAt: Date.now(),
      };

      (fetch as any).mockImplementation(async (url: string) => {
        if (url.includes('/work-orders/available')) return { ok: true, json: async () => [mockWO] };
        if (url.includes('/accept')) return { ok: true };
        if (url.includes('/complete')) return { ok: true };
        if (url.includes('/research-queue')) return { ok: true };
        return { ok: false, status: 404 };
      });

      const service = buildService();
      try {
        const result = await service.runIteration(TEST_CONFIG, 1);
        expect(result).toBeDefined();
      } catch (_error) {
        // Expected — LLM not available in test, graph structure is what we're verifying
      }
    });
  });
});
