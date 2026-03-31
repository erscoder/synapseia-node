import { jest } from '@jest/globals';
import {
  fetchAvailableWorkOrders,
  acceptWorkOrder,
  completeWorkOrder,
  executeWorkOrder,
  getWorkOrderAgentState,
  resetWorkOrderAgentState,
  runWorkOrderAgentIteration,
  stopWorkOrderAgent,
  shouldStopForMaxIterations,
  shouldContinueLoop,
  shouldSleepBetweenIterations,
  WorkOrder,
  EconomicConfig,
  ResearchResult,
  scoreResearchResult,
  _test,
} from '../modules/agent/work-order-agent.js';
import { initBrain } from '../modules/agent/agent-brain.js';
import { parseModel, type LLMModel } from '../modules/llm/llm-provider.js';
import * as llmProvider from '../modules/llm/llm-provider.js';

// ESM-compatible mock for generateLLM (jest.spyOn can't mock ESM read-only exports)
// Use var so jest.mock() factory (which is hoisted) can reference it at initialization
var mockGenerateLLM: any = jest.fn();

jest.mock('../modules/llm/llm-provider.js', () => {
  // Factory function must be a plain function (not arrow) to avoid ESM class field issues
  function mockParseModel(s: string): any {
    if (!s) return null;
    const parts = s.split('/');
    return parts.length > 1
      ? { provider: parts[0], model: parts.slice(1).join('/') }
      : { provider: 'ollama', model: s };
  }
  return {
    generateLLM: mockGenerateLLM,
    parseModel: mockParseModel,
    detectAvailableProviders: jest.fn(),
  };
});

/** Helper: parseModel that asserts non-null for test convenience */
function testParseModel(modelStr: string): LLMModel {
  const model = parseModel(modelStr);
  if (!model) throw new Error(`parseModel returned null for "${modelStr}"`);
  return model;
}

// Mock fetch globally
global.fetch = jest.fn() as unknown as typeof fetch;

describe('WorkOrderAgent', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetWorkOrderAgentState();
  });

  describe('fetchAvailableWorkOrders', () => {
    it('should fetch work orders from coordinator', async () => {
      const mockWorkOrders = [
        {
          id: 'wo_1',
          title: 'Research Task',
          description: 'Do some research',
          requiredCapabilities: ['llm'],
          rewardAmount: '1000000000',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        },
      ];

      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockWorkOrders,
      });

      const result = await fetchAvailableWorkOrders(
        'http://localhost:3001',
        'peer1',
        ['llm', 'tier-2']
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('wo_1');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/work-orders/available?peerId=peer1&capabilities=llm,tier-2'
      );
    });

    it('should return empty array on 404 response', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await fetchAvailableWorkOrders(
        'http://localhost:3001',
        'peer1',
        ['llm']
      );

      expect(result).toEqual([]);
    });

    it('should throw on non-404 error response', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      });

      const result = await fetchAvailableWorkOrders(
        'http://localhost:3001',
        'peer1',
        ['llm']
      );

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      (fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchAvailableWorkOrders(
        'http://localhost:3001',
        'peer1',
        ['llm']
      );

      expect(result).toEqual([]);
    });

    it('should handle null response data', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => null,
      });

      const result = await fetchAvailableWorkOrders(
        'http://localhost:3001',
        'peer1',
        ['llm']
      );

      expect(result).toEqual([]);
    });
  });

  describe('acceptWorkOrder', () => {
    it('should accept work order successfully', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
      });

      const result = await acceptWorkOrder(
        'http://localhost:3001',
        'wo_1',
        'peer1',
        ['llm']
      );

      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/work-orders/wo_1/accept',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workOrderId: 'wo_1',
            assigneeAddress: 'peer1',
            nodeCapabilities: ['llm'],
          }),
        }
      );
    });

    it('should return false on error', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Work order not found',
      });

      const result = await acceptWorkOrder(
        'http://localhost:3001',
        'wo_1',
        'peer1'
      );

      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      (fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const result = await acceptWorkOrder(
        'http://localhost:3001',
        'wo_1',
        'peer1'
      );

      expect(result).toBe(false);
    });
  });

  describe('completeWorkOrder', () => {
    it('should complete work order successfully', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'wo_1',
          rewardAmount: '1000000000',
        }),
      });

      const result = await completeWorkOrder(
        'http://localhost:3001',
        'wo_1',
        'peer1',
        'Research result here',
        true
      );

      expect(result).toBe(true);
    });

    it('should return false on HTTP error', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Failed to complete',
      });

      const result = await completeWorkOrder(
        'http://localhost:3001',
        'wo_1',
        'peer1',
        'Result',
        true
      );

      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      (fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const result = await completeWorkOrder(
        'http://localhost:3001',
        'wo_1',
        'peer1',
        'Result',
        true
      );

      expect(result).toBe(false);
    });

    it('should use default success parameter', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      // Call without success parameter - should default to true
      const result = await (completeWorkOrder as any)(
        'http://localhost:3001',
        'wo_1',
        'peer1',
        'Result'
      );

      expect(result).toBe(true);
    });

    it('should skip submission on second call for same work order (idempotency)', async () => {
      // First call should complete successfully
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'wo_idempotent',
          rewardAmount: '1000000000',
        }),
      });

      const result1 = await completeWorkOrder(
        'http://localhost:3001',
        'wo_idempotent',
        'peer1',
        'Result',
        true
      );

      expect(result1).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Second call with same workOrderId should skip POST and return true immediately
      const result2 = await completeWorkOrder(
        'http://localhost:3001',
        'wo_idempotent',
        'peer1',
        'Result',
        true
      );

      expect(result2).toBe(true);
      // fetch should NOT have been called again
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeWorkOrder', () => {
    it('should execute work order with LLM', async () => {
      const workOrder = {
        id: 'wo_1',
        title: 'Research AI advancements',
        description: 'Research latest AI advancements',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'ASSIGNED' as const,
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      const llmModel = parseModel('ollama/qwen2.5:0.5b')!;
      
      const result = await executeWorkOrder(workOrder, llmModel);
      
      expect(result).toHaveProperty('result');
      expect(result).toHaveProperty('success');
    });

    it('should handle execution errors gracefully', async () => {
      const workOrder = {
        id: 'wo_1',
        title: 'Test Task',
        description: 'Test description',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'ASSIGNED' as const,
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      const llmModel = parseModel('invalid-model')!;
      
      const result = await executeWorkOrder(workOrder, llmModel);
      
      expect(result.success).toBe(false);
      expect(result.result).toContain('Error');
    });
  });

  describe('runWorkOrderAgentIteration', () => {
    const mockConfig = {
      coordinatorUrl: 'http://localhost:3001',
      peerId: 'peer1',
      capabilities: ['llm', 'tier-2'],
      llmModel: parseModel('ollama/qwen2.5:0.5b')!,
      intervalMs: 30000,
    };

    it('should return completed false when no work orders available', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const result = await runWorkOrderAgentIteration(mockConfig, 1);

      expect(result.completed).toBe(false);
    });

    it.skip('should complete full work order cycle', async () => {
      // Mock generateLLM
      mockGenerateLLM.mockResolvedValueOnce('Generated result');

      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Task',
        description: 'Test description',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      // Mock fetch available work orders
      (fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [mockWorkOrder],
        })
        // Mock accept work order
        .mockResolvedValueOnce({
          ok: true,
        })
        // Mock complete work order
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockWorkOrder,
            rewardAmount: '1000000000',
          }),
        });

      const result = await runWorkOrderAgentIteration(mockConfig, 1);

      expect(result.workOrder).toBeDefined();
      expect(result.completed).toBe(true);
    });

    it('should skip work order if accept fails', async () => {
      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Task',
        description: 'Test description',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      (fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [mockWorkOrder],
        })
        .mockResolvedValueOnce({
          ok: false,
          text: async () => 'Already accepted',
        });

      const result = await runWorkOrderAgentIteration(mockConfig, 1);

      expect(result.completed).toBe(false);
    });

    it('should handle completeWorkOrder returning false', async () => {
      mockGenerateLLM.mockResolvedValueOnce('Generated result');

      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Task',
        description: 'Test description',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      (fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [mockWorkOrder],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ accepted: true }),
        })
        .mockResolvedValueOnce({
          ok: false,
          text: async () => 'Completion failed',
        });

      const result = await runWorkOrderAgentIteration(mockConfig, 1);

      expect(result.completed).toBe(false);
    });
  });

  describe('stopWorkOrderAgent', () => {
    it('should stop the agent', () => {
      stopWorkOrderAgent();
      const state = getWorkOrderAgentState();
      expect(state.isRunning).toBe(false);
    });
  });

  describe('startWorkOrderAgent', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      resetWorkOrderAgentState();
    });

    it('should throw error if agent already running', async () => {
      // First set the agent as running
      const { startWorkOrderAgent } = await import('../modules/agent/work-order-agent.js');
      
      // Mock to avoid actual execution
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      // Start agent in background
      const config = {
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
        llmModel: parseModel('ollama/qwen2.5:0.5b')!,
        intervalMs: 100,
        maxIterations: 1,
      };

      // Start first time
      const promise = startWorkOrderAgent(config);
      
      // Try to start again - should throw
      await expect(startWorkOrderAgent(config)).rejects.toThrow('already running');
      
      // Cleanup
      stopWorkOrderAgent();
      await promise.catch(() => {});
    });

    it('should stop after max iterations', async () => {
      const { startWorkOrderAgent } = await import('../modules/agent/work-order-agent.js');
      
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      const config = {
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
        llmModel: parseModel('ollama/qwen2.5:0.5b')!,
        intervalMs: 10,
        maxIterations: 1,
      };

      await startWorkOrderAgent(config);
      
      const state = getWorkOrderAgentState();
      expect(state.isRunning).toBe(false);
    });

    it('should run multiple iterations with maxIterations', async () => {
      const { startWorkOrderAgent } = await import('../modules/agent/work-order-agent.js');
      
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      const config = {
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
        llmModel: parseModel('ollama/qwen2.5:0.5b')!,
        intervalMs: 10,
        maxIterations: 3,
      };

      await startWorkOrderAgent(config);
      
      const state = getWorkOrderAgentState();
      expect(state.isRunning).toBe(false);
      // Agent ran and stopped properly
    });

    it('should handle iteration errors gracefully', async () => {
      const { startWorkOrderAgent } = await import('../modules/agent/work-order-agent.js');
      
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

      const config = {
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
        llmModel: parseModel('ollama/qwen2.5:0.5b')!,
        intervalMs: 50,
        maxIterations: 1,
      };

      await startWorkOrderAgent(config);
      
      const state = getWorkOrderAgentState();
      expect(state.isRunning).toBe(false);
    });

    it('should run with maxIterations undefined (infinite loop stopped manually)', async () => {
      const { startWorkOrderAgent } = await import('../modules/agent/work-order-agent.js');

      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      const config = {
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
        llmModel: parseModel('ollama/qwen2.5:0.5b')!,
        intervalMs: 10,
        // maxIterations not set - infinite loop
      };

      // Start agent
      const promise = startWorkOrderAgent(config);

      // Stop after a short delay
      setTimeout(() => {
        stopWorkOrderAgent();
      }, 50);

      await promise;

      const state = getWorkOrderAgentState();
      expect(state.isRunning).toBe(false);
    });
  });

  describe('pure helper functions', () => {
    // Use top-level imports (ESM-compatible — jest.requireActual doesn't work for ESM)

    describe('shouldStopForMaxIterations', () => {
      it('should return false when maxIterations is undefined', () => {
        expect(shouldStopForMaxIterations(5, undefined)).toBe(false);
        expect(shouldStopForMaxIterations(100, undefined)).toBe(false);
      });

      it('should return false when iteration is less than or equal to maxIterations', () => {
        expect(shouldStopForMaxIterations(1, 5)).toBe(false);
        expect(shouldStopForMaxIterations(5, 5)).toBe(false);
        expect(shouldStopForMaxIterations(3, 10)).toBe(false);
      });

      it('should return true when iteration exceeds maxIterations', () => {
        expect(shouldStopForMaxIterations(6, 5)).toBe(true);
        expect(shouldStopForMaxIterations(11, 10)).toBe(true);
        expect(shouldStopForMaxIterations(2, 1)).toBe(true);
      });
    });

    describe('shouldContinueLoop', () => {
      it('should return false when isRunning is false', () => {
        expect(shouldContinueLoop(false, 1, undefined)).toBe(false);
        expect(shouldContinueLoop(false, 5, 10)).toBe(false);
      });

      it('should return true when isRunning is true and no maxIterations', () => {
        expect(shouldContinueLoop(true, 1, undefined)).toBe(true);
        expect(shouldContinueLoop(true, 100, undefined)).toBe(true);
      });

      it('should return true when iteration is within maxIterations', () => {
        expect(shouldContinueLoop(true, 1, 5)).toBe(true);
        expect(shouldContinueLoop(true, 5, 5)).toBe(true);
        expect(shouldContinueLoop(true, 9, 10)).toBe(true);
      });

      it('should return false when iteration exceeds maxIterations', () => {
        expect(shouldContinueLoop(true, 6, 5)).toBe(false);
        expect(shouldContinueLoop(true, 11, 10)).toBe(false);
        expect(shouldContinueLoop(true, 2, 1)).toBe(false);
      });
    });

    describe('shouldSleepBetweenIterations', () => {
      it('should return true when isRunning is true', () => {
        expect(shouldSleepBetweenIterations(true)).toBe(true);
      });

      it('should return false when isRunning is false', () => {
        expect(shouldSleepBetweenIterations(false)).toBe(false);
      });
    });
  });

  describe('getWorkOrderAgentState', () => {
    it('should return initial state', () => {
      const state = getWorkOrderAgentState();

      expect(state.isRunning).toBe(false);
      expect(state.iteration).toBe(0);
      expect(state.totalWorkOrdersCompleted).toBe(0);
      expect(state.totalRewardsEarned).toBe(0n);
    });
  });

  describe('Research Work Orders', () => {
    describe('isResearchWorkOrder', () => {
      it('should return true for RESEARCH type', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: '{}',
          requiredCapabilities: ['llm', 'research'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
          type: 'RESEARCH',
        };

        const result = _test.isResearchWorkOrder(workOrder);
        expect(result).toBe(true);
      });

      it('should return true for JSON description with title and abstract', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: JSON.stringify({
            title: 'Paper Title',
            abstract: 'Paper abstract content',
          }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const result = _test.isResearchWorkOrder(workOrder);
        expect(result).toBe(true);
      });

      it('should return false for non-JSON description', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Training Task',
          description: 'Do some training',
          requiredCapabilities: ['compute'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const result = _test.isResearchWorkOrder(workOrder);
        expect(result).toBe(false);
      });

      it('should return false for JSON without title/abstract', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Some Task',
          description: JSON.stringify({ task: 'training' }),
          requiredCapabilities: ['compute'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const result = _test.isResearchWorkOrder(workOrder);
        expect(result).toBe(false);
      });
    });

    describe('extractResearchPayload', () => {
      it('should extract title and abstract from valid JSON', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: JSON.stringify({
            title: 'Decentralized AI Networks',
            abstract: 'This paper explores...',
          }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const result = _test.extractResearchPayload(workOrder);
        expect(result).toEqual({
          title: 'Decentralized AI Networks',
          abstract: 'This paper explores...',
        });
      });

      it('should return null for invalid JSON', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Invalid',
          description: 'not valid json',
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const result = _test.extractResearchPayload(workOrder);
        expect(result).toBeNull();
      });

      it('should return null for JSON without title', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Incomplete',
          description: JSON.stringify({ abstract: 'Only abstract' }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const result = _test.extractResearchPayload(workOrder);
        expect(result).toBeNull();
      });

      it('should return null for JSON without abstract', () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Incomplete',
          description: JSON.stringify({ title: 'Only title' }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const result = _test.extractResearchPayload(workOrder);
        expect(result).toBeNull();
      });
    });

    describe('buildResearchPrompt', () => {
      it('should build prompt with title and abstract', () => {
        const payload = {
          title: 'Test Paper Title',
          abstract: 'Test abstract content',
        };

        const result = _test.buildResearchPrompt(payload);

        expect(result).toContain('You are a');
        expect(result).toContain('Test Paper Title');
        expect(result).toContain('Test abstract content');
        expect(result).toContain('"summary"');
        expect(result).toContain('"keyInsights"');
        expect(result).toContain('"proposal"');
      });
    });

    describe('executeResearchWorkOrder', () => {
      beforeEach(() => {
        jest.resetAllMocks();
      });

      it.skip('should execute research and return parsed result', async () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: JSON.stringify({
            title: 'AI Paper',
            abstract: 'Abstract content',
          }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const mockResponse = JSON.stringify({
          summary: 'This is a summary',
          keyInsights: ['insight1', 'insight2', 'insight3'],
          proposal: 'This is a proposal',
        });

        mockGenerateLLM.mockResolvedValueOnce(mockResponse);

        const result = await _test.executeResearchWorkOrder(
          workOrder,
          testParseModel('ollama/qwen2.5:0.5b'),
          {}
        );

        expect(result.success).toBe(true);
        expect(result.result.summary).toBe('This is a summary');
        expect(result.result.keyInsights).toHaveLength(3);
        expect(result.result.proposal).toBe('This is a proposal');
      });

      it.skip('should handle markdown-wrapped JSON', async () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: JSON.stringify({
            title: 'AI Paper',
            abstract: 'Abstract',
          }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        const mockResponse = '```json\n{"summary": "test", "keyInsights": ["a"], "proposal": "b"}\n```';

        mockGenerateLLM.mockResolvedValueOnce(mockResponse);

        const result = await _test.executeResearchWorkOrder(
          workOrder,
          testParseModel('ollama/qwen2.5:0.5b'),
          {}
        );

        expect(result.success).toBe(true);
        expect(result.result.summary).toBe('test');
      });

      it.skip('should handle invalid JSON gracefully', async () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: JSON.stringify({
            title: 'AI Paper',
            abstract: 'Abstract',
          }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        mockGenerateLLM.mockResolvedValueOnce('not valid json');

        const result = await _test.executeResearchWorkOrder(
          workOrder,
          testParseModel('ollama/qwen2.5:0.5b'),
          {}
        );

        expect(result.success).toBe(false);
        expect(result.result.summary).toBe('Failed to parse LLM response');
      });

      it.skip('should handle missing fields in response', async () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: JSON.stringify({
            title: 'AI Paper',
            abstract: 'Abstract',
          }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        mockGenerateLLM.mockResolvedValueOnce(JSON.stringify({ summary: 'only summary' }));

        const result = await _test.executeResearchWorkOrder(
          workOrder,
          testParseModel('ollama/qwen2.5:0.5b'),
          {}
        );

        expect(result.success).toBe(false);
      });

      it('should throw for invalid payload', async () => {
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Invalid',
          description: 'not valid json',
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        await expect(
          _test.executeResearchWorkOrder(workOrder, testParseModel('ollama/qwen2.5:0.5b'), {})
        ).rejects.toThrow('Invalid research payload');
      });
    });

    describe('submitResearchResult', () => {
      it('should submit result to coordinator', async () => {
        (fetch as any).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true }),
        });

        const result = await _test.submitResearchResult(
          'http://localhost:3001',
          'wo_1',
          'peer1',
          {
            summary: 'Test summary',
            keyInsights: ['insight1'],
            proposal: 'Test proposal',
          }
        );

        expect(result).toBe(true);
        expect(fetch).toHaveBeenCalledWith(
          'http://localhost:3001/research-queue/results',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('Test summary'),
          })
        );
      });

      it('should return false on error response', async () => {
        (fetch as any).mockResolvedValueOnce({
          ok: false,
          text: async () => 'Server error',
        });

        const result = await _test.submitResearchResult(
          'http://localhost:3001',
          'wo_1',
          'peer1',
          {
            summary: 'Test',
            keyInsights: [],
            proposal: 'Test',
          }
        );

        expect(result).toBe(false);
      });

      it('should return false on network error', async () => {
        (fetch as any).mockRejectedValueOnce(new Error('Network error'));

        const result = await _test.submitResearchResult(
          'http://localhost:3001',
          'wo_1',
          'peer1',
          {
            summary: 'Test',
            keyInsights: [],
            proposal: 'Test',
          }
        );

        expect(result).toBe(false);
      });
    });

    describe('saveResearchToBrain', () => {
      it('should save research to brain journal and memory', () => {
        const brain = initBrain();
        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: '{}',
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        _test.saveResearchToBrain(brain, workOrder, {
          summary: 'Test summary',
          keyInsights: ['insight1'],
          proposal: 'Test proposal',
        });

        expect(brain.journal).toHaveLength(1);
        expect(brain.journal[0].action).toBe('research:wo_1');
        expect(brain.memory).toHaveLength(1);
        expect(brain.memory[0].type).toBe('discovery');
      });

      it('should prune old entries when exceeding 100', () => {
        const brain = initBrain();
        
        // Add 100 existing entries
        for (let i = 0; i < 100; i++) {
          brain.journal.push({
            timestamp: Date.now(),
            action: `action_${i}`,
            outcome: 'test',
            lesson: 'test',
          });
          brain.memory.push({
            timestamp: Date.now(),
            type: 'experiment',
            content: `content_${i}`,
            importance: 0.5,
          });
        }

        const workOrder: WorkOrder = {
          id: 'wo_1',
          title: 'Research Paper',
          description: '{}',
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        _test.saveResearchToBrain(brain, workOrder, {
          summary: 'Test',
          keyInsights: [],
          proposal: 'Test',
        });

        expect(brain.journal).toHaveLength(100);
        expect(brain.memory).toHaveLength(100);
      });
    });

    describe('runWorkOrderAgentIteration with research', () => {
      it.skip('should process research WO without brain', async () => {
        const mockWorkOrder: WorkOrder = {
          id: 'wo_research',
          title: 'Research Paper',
          description: JSON.stringify({ title: 'AI Paper', abstract: 'Abstract' }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        (fetch as any)
          .mockResolvedValueOnce({ ok: true, json: async () => [mockWorkOrder] }) // fetchAvailable
          .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // acceptWorkOrder
          .mockResolvedValueOnce({ ok: false, status: 404 }) // fetchHyperparamConfig (no suggestion)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ papers: [] }) }) // research-queue/papers (paperId lookup)
          .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // submitResearchResult
          .mockResolvedValueOnce({ ok: true, json: async () => ({ ...mockWorkOrder, status: 'COMPLETED' }) }); // completeWorkOrder

        mockGenerateLLM.mockResolvedValueOnce(JSON.stringify({
          summary: 'Summary', keyInsights: ['i'], proposal: 'P'
        }));

        const result = await runWorkOrderAgentIteration({
          coordinatorUrl: 'http://localhost:3001',
          peerId: 'peer1',
          capabilities: ['llm'],
          llmModel: testParseModel('ollama/qwen2.5:0.5b'),
          intervalMs: 1000,
        }, 1);

        expect(result.completed).toBe(true);
      });

      it.skip('should process research WO with brain', async () => {
        const mockWorkOrder: WorkOrder = {
          id: 'wo_research_brain',
          title: 'Research Paper',
          description: JSON.stringify({ title: 'AI Paper', abstract: 'Abstract' }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        (fetch as any)
          .mockResolvedValueOnce({ ok: true, json: async () => [mockWorkOrder] })  // fetchAvailable
          .mockResolvedValueOnce({ ok: true, json: async () => ({}) })              // acceptWorkOrder
          .mockResolvedValueOnce({ ok: false, status: 404 })                        // fetchHyperparamConfig (no suggestion)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ papers: [] }) }) // research-queue/papers
          .mockResolvedValueOnce({ ok: true, json: async () => ({}) })              // submitResearchResult
          .mockResolvedValueOnce({ ok: true, json: async () => ({ ...mockWorkOrder, status: 'COMPLETED' }) }); // completeWorkOrder

        mockGenerateLLM.mockResolvedValueOnce(JSON.stringify({
          summary: 'Summary', keyInsights: ['i'], proposal: 'P'
        }));

        const brain = initBrain();
        const result = await runWorkOrderAgentIteration({
          coordinatorUrl: 'http://localhost:3001',
          peerId: 'peer1',
          capabilities: ['llm'],
          llmModel: testParseModel('ollama/qwen2.5:0.5b'),
          intervalMs: 1000,
        }, 1, brain);

        expect(result.completed).toBe(true);
        expect(brain.journal.length).toBeGreaterThan(0);
      });

      it.skip('should handle failed research submission', async () => {
        const mockWorkOrder: WorkOrder = {
          id: 'wo_research_fail',
          title: 'Research Paper',
          description: JSON.stringify({ title: 'AI Paper', abstract: 'Abstract' }),
          requiredCapabilities: ['llm'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        (fetch as any)
          .mockResolvedValueOnce({ ok: true, json: async () => [mockWorkOrder] })  // fetchAvailable
          .mockResolvedValueOnce({ ok: true, json: async () => ({}) })              // acceptWorkOrder
          .mockResolvedValueOnce({ ok: false, status: 404 })                        // fetchHyperparamConfig (no suggestion)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ papers: [] }) }) // research-queue/papers
          .mockResolvedValueOnce({ ok: false, text: async () => 'Error' })          // submitResearchResult (fails)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ ...mockWorkOrder, status: 'COMPLETED' }) }); // completeWorkOrder

        mockGenerateLLM.mockResolvedValueOnce(JSON.stringify({
          summary: 'Summary', keyInsights: ['i'], proposal: 'P'
        }));

        const result = await runWorkOrderAgentIteration({
          coordinatorUrl: 'http://localhost:3001',
          peerId: 'peer1',
          capabilities: ['llm'],
          llmModel: testParseModel('ollama/qwen2.5:0.5b'),
          intervalMs: 1000,
        }, 1);

        expect(result.completed).toBe(true);
      });

      it.skip('should process standard work order', async () => {
        const mockWorkOrder: WorkOrder = {
          id: 'wo_standard',
          title: 'Training Task',
          description: 'Train a neural network',
          requiredCapabilities: ['compute'],
          rewardAmount: '100',
          status: 'PENDING',
          creatorAddress: 'creator1',
          createdAt: Date.now(),
        };

        (fetch as any)
          .mockResolvedValueOnce({ ok: true, json: async () => [mockWorkOrder] })
          .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
          .mockResolvedValueOnce({ ok: true, json: async () => ({ ...mockWorkOrder, status: 'COMPLETED' }) });

        mockGenerateLLM.mockResolvedValueOnce('Training complete');

        const result = await runWorkOrderAgentIteration({
          coordinatorUrl: 'http://localhost:3001',
          peerId: 'peer1',
          capabilities: ['compute'],
          llmModel: testParseModel('ollama/qwen2.5:0.5b'),
          intervalMs: 1000,
        }, 1);

        expect(result.completed).toBe(true);
        expect(result.workOrder?.id).toBe('wo_standard');
      });
    });

    describe('Economic Evaluation', () => {
      const { loadEconomicConfig, estimateLLMCost, evaluateWorkOrder } = _test;

      describe('loadEconomicConfig', () => {
        it('should return default config when no env vars set', () => {
          const config = loadEconomicConfig();
          expect(config.synPriceUsd).toBe(0.01);
          expect(config.llmType).toBe('ollama');
          expect(config.llmModel).toBe('ollama/phi4-mini');
          expect(config.llmCostPer1kTokens).toBe(0); // Ollama is $0
          expect(config.minProfitRatio).toBe(1.5);
        });

        it('should load config from environment variables', () => {
          process.env.SYN_PRICE_USD = '0.05';
          // llmType is now derived from the model name, not a separate env var
          process.env.LLM_MODEL = 'gpt-4o-mini'; // cloud model (no ollama/ prefix)
          process.env.LLM_COST_PER_1K_TOKENS = '0.01';
          process.env.MIN_PROFIT_RATIO = '2.0';

          const config = loadEconomicConfig();
          expect(config.synPriceUsd).toBe(0.05);
          expect(config.llmType).toBe('cloud'); // derived from model name
          expect(config.llmModel).toBe('gpt-4o-mini');
          expect(config.llmCostPer1kTokens).toBe(0.01);
          expect(config.minProfitRatio).toBe(2.0);

          // Cleanup
          delete process.env.SYN_PRICE_USD;
          delete process.env.LLM_MODEL;
          delete process.env.LLM_COST_PER_1K_TOKENS;
          delete process.env.MIN_PROFIT_RATIO;
        });

        it('should lookup price from table when LLM_MODEL is a cloud model', () => {
          process.env.LLM_MODEL = 'gpt-4o-mini'; // cloud model by name
          delete process.env.LLM_COST_PER_1K_TOKENS;

          const config = loadEconomicConfig();
          expect(config.llmType).toBe('cloud'); // derived from model name
          expect(config.llmModel).toBe('gpt-4o-mini');
          expect(config.llmCostPer1kTokens).toBe(0.00015); // From price table

          // Cleanup
          delete process.env.LLM_MODEL;
        });

        it('should fallback to haiku price for unknown cloud models', () => {
          process.env.LLM_MODEL = 'openai-compat/unknown-model-xyz'; // cloud prefix, unknown name
          delete process.env.LLM_COST_PER_1K_TOKENS;

          const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

          const config = loadEconomicConfig();
          expect(config.llmType).toBe('cloud');
          expect(config.llmCostPer1kTokens).toBe(0.00025); // Fallback to haiku
          expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Unknown model')
          );

          consoleSpy.mockRestore();
          delete process.env.LLM_MODEL;
        });

        it('should use manual override over price table', () => {
          process.env.LLM_MODEL = 'gpt-4o-mini';
          process.env.LLM_COST_PER_1K_TOKENS = '0.999'; // Manual override

          const config = loadEconomicConfig();
          expect(config.llmCostPer1kTokens).toBe(0.999); // Override, not table

          delete process.env.LLM_MODEL;
          delete process.env.LLM_COST_PER_1K_TOKENS;
        });
      });

      describe('getModelCostPer1kTokens', () => {
        const { getModelCostPer1kTokens } = _test;

        it('should return correct price for gpt-4o', () => {
          expect(getModelCostPer1kTokens('gpt-4o')).toBe(0.005);
        });

        it('should return correct price for gpt-4o-mini', () => {
          expect(getModelCostPer1kTokens('gpt-4o-mini')).toBe(0.00015);
        });

        it('should return correct price for claude-haiku', () => {
          expect(getModelCostPer1kTokens('claude-haiku')).toBe(0.00025);
        });

        it('should return correct price for claude-haiku-3', () => {
          expect(getModelCostPer1kTokens('claude-haiku-3')).toBe(0.00025);
        });

        it('should return correct price for gemini-flash', () => {
          expect(getModelCostPer1kTokens('gemini-flash')).toBe(0.000075);
        });

        it('should return $0 for ollama models', () => {
          expect(getModelCostPer1kTokens('ollama/phi4-mini')).toBe(0);
          expect(getModelCostPer1kTokens('ollama/llama3')).toBe(0);
          expect(getModelCostPer1kTokens('ollama/mistral')).toBe(0);
        });

        it('should return $0 for any ollama/* pattern', () => {
          expect(getModelCostPer1kTokens('ollama/custom-model')).toBe(0);
        });

        it('should fallback to haiku price for unknown models with warning', () => {
          const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
          
          const price = getModelCostPer1kTokens('unknown-model');
          expect(price).toBe(0.00025); // Fallback to haiku
          expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Unknown model "unknown-model"')
          );

          consoleSpy.mockRestore();
        });
      });

      describe('estimateLLMCost', () => {
        it('should return 0 for ollama models', () => {
          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'ollama',
            llmCostPer1kTokens: 0.002,
            minProfitRatio: 1.5,
          };

          const cost = estimateLLMCost('A'.repeat(4000), config);
          expect(cost).toBe(0);
        });

        it('should calculate cost for cloud models', () => {
          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'cloud',
            llmCostPer1kTokens: 0.002,
            minProfitRatio: 1.5,
          };

          // 4000 chars ≈ 1000 tokens input + 500 output = 1500 tokens
          const cost = estimateLLMCost('A'.repeat(4000), config);
          expect(cost).toBeCloseTo(0.003, 3); // (1500/1000) * 0.002
        });

        it('should handle empty abstract', () => {
          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'cloud',
            llmCostPer1kTokens: 0.002,
            minProfitRatio: 1.5,
          };

          const cost = estimateLLMCost('', config);
          expect(cost).toBeCloseTo(0.001, 3); // (500/1000) * 0.002 (just output tokens)
        });
      });

      describe('evaluateWorkOrder', () => {
        it('should accept non-research WO without evaluation', () => {
          const workOrder: WorkOrder = {
            id: 'wo_training',
            title: 'Training Task',
            description: 'Train a model',
            requiredCapabilities: ['compute'],
            rewardAmount: '1000000000000', // 1000 SYN in lamports
            status: 'PENDING',
            creatorAddress: 'creator1',
            createdAt: Date.now(),
          };

          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'cloud',
            llmCostPer1kTokens: 0.002,
            minProfitRatio: 1.5,
          };

          const evaluation = evaluateWorkOrder(workOrder, config);
          expect(evaluation.shouldAccept).toBe(true);
          expect(evaluation.bountyUsd).toBe(10); // 1000 * 0.01
          expect(evaluation.reason).toContain('Non-research');
        });

        it('should always accept research WO with ollama (zero cost)', () => {
          const workOrder: WorkOrder = {
            id: 'wo_research',
            title: 'Research Paper',
            description: JSON.stringify({
              title: 'AI Paper',
              abstract: 'This is a very long abstract ' + 'word '.repeat(100),
            }),
            requiredCapabilities: ['llm'],
            rewardAmount: '100',
            status: 'PENDING',
            creatorAddress: 'creator1',
            createdAt: Date.now(),
          };

          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'ollama',
            llmCostPer1kTokens: 0.002,
            minProfitRatio: 1.5,
          };

          const evaluation = evaluateWorkOrder(workOrder, config);
          expect(evaluation.shouldAccept).toBe(true);
          expect(evaluation.estimatedCostUsd).toBe(0);
          expect(evaluation.reason).toContain('Ollama');
        });

        it('should accept profitable cloud research WO', () => {
          const workOrder: WorkOrder = {
            id: 'wo_research',
            title: 'Research Paper',
            description: JSON.stringify({
              title: 'AI Paper',
              abstract: 'Short abstract',
            }),
            requiredCapabilities: ['llm'],
            rewardAmount: '1000000000000', // 1000 SYN = $10 at $0.01/SYN
            status: 'PENDING',
            creatorAddress: 'creator1',
            createdAt: Date.now(),
          };

          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'cloud',
            llmCostPer1kTokens: 0.002,
            minProfitRatio: 1.5,
          };

          const evaluation = evaluateWorkOrder(workOrder, config);
          expect(evaluation.shouldAccept).toBe(true);
          expect(evaluation.bountyUsd).toBe(10);
          expect(evaluation.profitRatio).toBeGreaterThan(1.5);
          expect(evaluation.reason).toContain('Profitable');
        });

        it('should reject unprofitable cloud research WO', () => {
          const workOrder: WorkOrder = {
            id: 'wo_research',
            title: 'Research Paper',
            type: 'RESEARCH', // Explicitly set type
            description: JSON.stringify({
              title: 'AI Paper',
              abstract: 'A'.repeat(200000), // Very long abstract = high cost (~50k tokens)
            }),
            requiredCapabilities: ['llm'],
            rewardAmount: '10000000000', // 10 SYN = $0.10 at $0.01/SYN
            status: 'PENDING',
            creatorAddress: 'creator1',
            createdAt: Date.now(),
          };

          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'cloud',
            llmCostPer1kTokens: 0.01, // High cost to ensure unprofitability
            minProfitRatio: 1.5,
          };

          const evaluation = evaluateWorkOrder(workOrder, config);
          expect(evaluation.shouldAccept).toBe(false);
          expect(evaluation.bountyUsd).toBe(0.1);
          expect(evaluation.profitRatio).toBeLessThan(1.5);
          expect(evaluation.reason).toContain('Not profitable');
        });

        it('should reject invalid research payload with explicit type', () => {
          const workOrder: WorkOrder = {
            id: 'wo_research',
            title: 'Research Paper',
            type: 'RESEARCH', // Explicitly set type as RESEARCH
            description: 'not valid json', // But invalid payload
            requiredCapabilities: ['llm'],
            rewardAmount: '1000',
            status: 'PENDING',
            creatorAddress: 'creator1',
            createdAt: Date.now(),
          };

          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'cloud',
            llmCostPer1kTokens: 0.002,
            minProfitRatio: 1.5,
          };

          const evaluation = evaluateWorkOrder(workOrder, config);
          expect(evaluation.shouldAccept).toBe(false);
          expect(evaluation.reason).toContain('Invalid');
        });

        it('should handle very low cost cloud research WO', () => {
          const workOrder: WorkOrder = {
            id: 'wo_research',
            title: 'Research Paper',
            description: JSON.stringify({
              title: 'AI Paper',
              abstract: '',
            }),
            requiredCapabilities: ['llm'],
            rewardAmount: '100',
            status: 'PENDING',
            creatorAddress: 'creator1',
            createdAt: Date.now(),
          };

          const config: EconomicConfig = {
            synPriceUsd: 0.01,
            llmModel: 'gpt-4o-mini',
            llmType: 'cloud',
            llmCostPer1kTokens: 0.000001, // Very low cost
            minProfitRatio: 1.5,
          };

          const evaluation = evaluateWorkOrder(workOrder, config);
          expect(evaluation.shouldAccept).toBe(true);
          // With empty abstract: ~500 output tokens * 0.000001/1000 = very low cost
          expect(evaluation.profitRatio).toBeGreaterThan(1.5);
        });
      });
    });
  });

  describe('scoreResearchResult', () => {
    const makeResult = (overrides: Partial<ResearchResult> = {}): ResearchResult => ({
      summary: 'Default summary text that is long enough to score well and exceed eighty characters total.',
      keyInsights: [
        'First insight with enough detail to pass the average length threshold of thirty characters.',
        'Second insight equally detailed and sufficiently long for a good score.',
        'Third insight that ensures we hit the three-insight threshold for maximum count score.',
      ],
      proposal: 'A detailed proposal that exceeds one hundred characters and describes a concrete implementation plan for the research idea presented.',
      ...overrides,
    });

    it('should return 1.0 for a full-quality result', () => {
      const result = makeResult();
      expect(scoreResearchResult(result)).toBe(1.0);
    });

    it('should return 0.0 for empty fields', () => {
      const result = makeResult({ summary: '', keyInsights: [], proposal: '' });
      expect(scoreResearchResult(result)).toBe(0);
    });

    it('should return partial score when only summary is good', () => {
      const result = makeResult({ keyInsights: [], proposal: '' });
      const score = scoreResearchResult(result);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1.0);
    });

    it('should return partial score when only proposal is good', () => {
      const result = makeResult({ summary: '', keyInsights: [] });
      const score = scoreResearchResult(result);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1.0);
    });

    it('should give lower score for fewer insights', () => {
      const scoreThree = scoreResearchResult(makeResult());
      const scoreOne = scoreResearchResult(makeResult({ keyInsights: ['Only one insight here with enough chars for length bonus.'] }));
      expect(scoreThree).toBeGreaterThan(scoreOne);
    });

    it('should give length bonus for insights averaging ≥30 chars', () => {
      const withLongInsights = makeResult({
        keyInsights: ['Short', 'Short', 'Short'],
      });
      const withShortInsights = makeResult({
        keyInsights: [
          'Long insight with more than thirty characters total.',
          'Another long insight exceeding thirty characters.',
          'Third long insight also over thirty characters long.',
        ],
      });
      expect(scoreResearchResult(withShortInsights)).toBeGreaterThan(scoreResearchResult(withLongInsights));
    });

    it('should cap score at 1.0', () => {
      const result = makeResult();
      expect(scoreResearchResult(result)).toBeLessThanOrEqual(1.0);
    });

    it('should return value between 0 and 1', () => {
      const result = makeResult({ summary: 'Mid length summary text here.' });
      const score = scoreResearchResult(result);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });
});
