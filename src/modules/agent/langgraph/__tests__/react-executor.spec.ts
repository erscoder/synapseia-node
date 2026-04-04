/**
 * Tests for ExecuteResearchNode with ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { ExecuteResearchNode } from '../nodes/execute-research';
import type { AgentState, WorkOrder } from '../state';

// Mock dependencies
const mockExecuteResearchWorkOrder = jest.fn();
const mockScoreResearchResult = jest.fn().mockReturnValue(0.85);
jest.mock('../../work-order/work-order.execution', () => ({
  WorkOrderExecutionHelper: jest.fn().mockImplementation(() => ({
    executeResearchWorkOrder: mockExecuteResearchWorkOrder,
  })),
}));
jest.mock('../../work-order/work-order.coordinator', () => ({
  WorkOrderCoordinatorHelper: jest.fn(),
}));
jest.mock('../../work-order/work-order.evaluation', () => ({
  WorkOrderEvaluationHelper: jest.fn().mockImplementation(() => ({
    scoreResearchResult: mockScoreResearchResult,
  })),
}));

jest.mock('../tools/tool-registry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    getAll: jest.fn().mockReturnValue([]),
    get: jest.fn(),
    toPromptString: jest.fn().mockReturnValue('- search_reference_corpus: Search corpus'),
  })),
}));

jest.mock('../tools/tool-runner.service', () => ({
  ToolRunnerService: jest.fn().mockImplementation(() => ({
    createExecutionContext: jest.fn().mockReturnValue({ callCount: 0, maxCalls: 5 }),
    run: jest.fn(),
  })),
}));

jest.mock('../llm.service', () => ({
  LangGraphLlmService: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
  })),
}));

jest.mock('../prompts/react', () => ({
  buildReActPrompt: jest.fn().mockReturnValue('mock react prompt'),
}));

jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Get mocked classes (jest.mock makes them available as jest.fn())
const { WorkOrderExecutionHelper } = require('../../work-order/work-order.execution');
const { WorkOrderEvaluationHelper } = require('../../work-order/work-order.evaluation');

describe('ExecuteResearchNode', () => {
  let node: ExecuteResearchNode;
  let mockToolRunner: any;
  let mockToolRegistry: any;
  let mockLlmService: any;
  let mockExecution: any;
  let mockEvaluation: any;

  const createMockState = (overrides: Partial<AgentState> = {}): AgentState => ({
    availableWorkOrders: [],
    selectedWorkOrder: null,
    economicEvaluation: null,
    executionResult: null,
    researchResult: null,
    qualityScore: 0,
    shouldSubmit: false,
    brain: {
      goals: [],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.5,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    },
    iteration: 0,
    accepted: false,
    submitted: false,
    config: {
      coordinatorUrl: 'http://localhost:3000',
      peerId: 'test-peer',
      capabilities: ['research'],
      llmModel: { provider: 'ollama', modelId: 'test-model', providerId: undefined },
      intervalMs: 1000,
    },
    coordinatorUrl: 'http://localhost:3000',
    peerId: 'test-peer',
    capabilities: ['research'],
    relevantMemories: [],
    executionPlan: [],
    currentStepIndex: 0,
    selfCritiqueScore: 0,
    selfCritiquePassed: false,
    selfCritiqueFeedback: '',
    retryCount: 0,
    ...overrides,
  });

  const createMockWorkOrder = (overrides: Partial<WorkOrder> = {}): WorkOrder => ({
    id: 'wo-123',
    title: 'Test Paper Analysis',
    description: JSON.stringify({
      title: 'Advances in Neural Networks',
      abstract: 'This paper explores new architectures for deep learning.',
    }),
    requiredCapabilities: ['research'],
    rewardAmount: '100.000000000',
    status: 'PENDING',
    creatorAddress: 'addr1',
    type: 'RESEARCH',
    createdAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockToolRegistry = {
      register: jest.fn(),
      getAll: jest.fn().mockReturnValue([]),
      get: jest.fn(),
      toPromptString: jest.fn().mockReturnValue('- search_reference_corpus: Search corpus'),
    };

    mockToolRunner = {
      createExecutionContext: jest.fn().mockReturnValue({ callCount: 0, maxCalls: 5 }),
      run: jest.fn(),
    };

    mockLlmService = {
      generate: jest.fn(),
    };
    mockExecution = new WorkOrderExecutionHelper();
    mockEvaluation = new WorkOrderEvaluationHelper();

    node = new ExecuteResearchNode(mockExecution, mockEvaluation, mockToolRunner, mockToolRegistry, mockLlmService);
  });

  describe('execute - no work order selected', () => {
    it('should return error when no work order is selected', async () => {
      const state = createMockState({ selectedWorkOrder: null });

      const result = await node.execute(state);

      expect(result.executionResult?.success).toBe(false);
      expect(result.executionResult?.result).toContain('No work order selected');
    });
  });

  describe('execute - ReAct loop with tool use', () => {
    it('should use tool when LLM decides to use_tool', async () => {
      const workOrder = createMockWorkOrder();
      const state = createMockState({ selectedWorkOrder: workOrder });

      // First iteration: LLM wants to use a tool
      mockLlmService.generate
        .mockResolvedValueOnce(JSON.stringify({
          thought: 'I need more context about neural networks',
          action: 'use_tool',
          toolCall: {
            toolName: 'search_reference_corpus',
            params: { topic: 'neural networks' },
          },
        }))
        // Second iteration: LLM generates answer
        .mockResolvedValueOnce(JSON.stringify({
          thought: 'I have enough information now',
          action: 'generate_answer',
          answer: JSON.stringify({
            summary: 'Test summary',
            keyInsights: ['Insight 1', 'Insight 2'],
            proposal: 'Test proposal',
          }),
        }));

      mockToolRunner.run.mockResolvedValueOnce({
        success: true,
        data: [{ title: 'Related Paper', score: 0.9 }],
        latencyMs: 100,
      });

      const result = await node.execute(state);

      expect(result.executionResult?.success).toBe(true);
      expect(result.researchResult).toEqual({
        summary: 'Test summary',
        keyInsights: ['Insight 1', 'Insight 2'],
        proposal: 'Test proposal',
      });
      expect(mockToolRunner.run).toHaveBeenCalledTimes(1);
    });

    it('should pass coordinatorUrl in tool params', async () => {
      const workOrder = createMockWorkOrder();
      const state = createMockState({ selectedWorkOrder: workOrder });

      mockLlmService.generate
        .mockResolvedValueOnce(JSON.stringify({
          thought: 'Search for context',
          action: 'use_tool',
          toolCall: {
            toolName: 'search_reference_corpus',
            params: { topic: 'ai' },
          },
        }))
        .mockResolvedValueOnce(JSON.stringify({
          thought: 'Generate answer',
          action: 'generate_answer',
          answer: JSON.stringify({
            summary: 'Test',
            keyInsights: [],
            proposal: 'Proposal',
          }),
        }));

      mockToolRunner.run.mockResolvedValueOnce({
        success: true,
        data: [],
        latencyMs: 50,
      });

      await node.execute(state);

      expect(mockToolRunner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            coordinatorUrl: 'http://localhost:3000',
          }),
        }),
      );
    });

    it('should handle tool execution errors gracefully', async () => {
      const workOrder = createMockWorkOrder();
      const state = createMockState({ selectedWorkOrder: workOrder });

      mockLlmService.generate
        .mockResolvedValueOnce(JSON.stringify({
          thought: 'Search for context',
          action: 'use_tool',
          toolCall: {
            toolName: 'search_reference_corpus',
            params: { topic: 'ai' },
          },
        }))
        .mockResolvedValueOnce(JSON.stringify({
          thought: 'Tool failed but I can still generate answer',
          action: 'generate_answer',
          answer: JSON.stringify({
            summary: 'Fallback summary',
            keyInsights: ['Fallback insight'],
            proposal: 'Fallback proposal',
          }),
        }));

      mockToolRunner.run.mockResolvedValueOnce({
        success: false,
        data: null,
        latencyMs: 100,
        error: 'Service unavailable',
      });

      const result = await node.execute(state);

      expect(result.executionResult?.success).toBe(true);
    });

    it('should respect max tool calls limit', async () => {
      const workOrder = createMockWorkOrder();
      const state = createMockState({ selectedWorkOrder: workOrder });

      // Track call count
      let callCount = 0;
      mockToolRunner.createExecutionContext.mockReturnValue({
        callCount: 0,
        maxCalls: 2,
      });

      mockLlmService.generate.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return Promise.resolve(JSON.stringify({
            thought: `Iteration ${callCount}`,
            action: 'use_tool',
            toolCall: {
              toolName: 'search_reference_corpus',
              params: { topic: `query-${callCount}` },
            },
          }));
        }
        return Promise.resolve(JSON.stringify({
          thought: 'Max calls reached, generating answer',
          action: 'generate_answer',
          answer: JSON.stringify({
            summary: 'Final summary',
            keyInsights: [],
            proposal: 'Final proposal',
          }),
        }));
      });

      mockToolRunner.run.mockResolvedValue({
        success: true,
        data: [],
        latencyMs: 50,
      });

      await node.execute(state);

      // Should stop at maxCalls (2) even if LLM wants more
      expect(mockToolRunner.run).toHaveBeenCalledTimes(2);
    });
  });

  describe('execute - direct answer without tools', () => {
    it('should handle direct answer without using tools', async () => {
      const workOrder = createMockWorkOrder();
      const state = createMockState({ selectedWorkOrder: workOrder });

      mockLlmService.generate.mockResolvedValueOnce(JSON.stringify({
        thought: 'I have enough information from the abstract',
        action: 'generate_answer',
        answer: JSON.stringify({
          summary: 'Direct analysis summary',
          keyInsights: ['Key finding 1', 'Key finding 2', 'Key finding 3'],
          proposal: 'Implementation proposal',
        }),
      }));

      const result = await node.execute(state);

      expect(result.executionResult?.success).toBe(true);
      expect(mockToolRunner.run).not.toHaveBeenCalled();
      expect(result.researchResult?.summary).toBe('Direct analysis summary');
    });
  });

  describe('execute - fallback on error', () => {
    it('should fall back to legacy executor on ReAct error', async () => {
      const workOrder = createMockWorkOrder();
      const state = createMockState({ selectedWorkOrder: workOrder });

      mockLlmService.generate.mockRejectedValue(new Error('LLM service error'));

      mockExecuteResearchWorkOrder.mockResolvedValue({
        result: {
          summary: 'Legacy summary',
          keyInsights: ['Legacy insight'],
          proposal: 'Legacy proposal',
        },
        rawResponse: 'legacy response',
        success: true,
      });

      const result = await node.execute(state);

      expect(result.executionResult?.success).toBe(true);
      expect(mockExecuteResearchWorkOrder).toHaveBeenCalled();
    });
  });
});
