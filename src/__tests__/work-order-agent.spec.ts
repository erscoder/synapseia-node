import {
  fetchAvailableWorkOrders,
  acceptWorkOrder,
  completeWorkOrder,
  executeWorkOrder,
  getWorkOrderAgentState,
  resetWorkOrderAgentState,
  runWorkOrderAgentIteration,
  stopWorkOrderAgent,
  WorkOrder,
} from '../work-order-agent.js';
import { parseModel } from '../llm-provider.js';
import * as llmProvider from '../llm-provider.js';

// Mock fetch globally
global.fetch = jest.fn();

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

      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchAvailableWorkOrders(
        'http://localhost:3001',
        'peer1',
        ['llm']
      );

      expect(result).toEqual([]);
    });

    it('should handle null response data', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
      });

      const result = await acceptWorkOrder(
        'http://localhost:3001',
        'wo_1',
        'peer1'
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
          }),
        }
      );
    });

    it('should return false on error', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

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
      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

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
      (fetch as jest.Mock).mockResolvedValueOnce({
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
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const result = await runWorkOrderAgentIteration(mockConfig, 1);

      expect(result.completed).toBe(false);
    });

    it('should complete full work order cycle', async () => {
      // Mock generateLLM
      jest.spyOn(llmProvider, 'generateLLM').mockResolvedValueOnce('Generated result');

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
      (fetch as jest.Mock)
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

      (fetch as jest.Mock)
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
      jest.spyOn(llmProvider, 'generateLLM').mockResolvedValueOnce('Generated result');

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

      (fetch as jest.Mock)
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
      const { startWorkOrderAgent } = await import('../work-order-agent.js');
      
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
      const { startWorkOrderAgent } = await import('../work-order-agent.js');
      
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
      const { startWorkOrderAgent } = await import('../work-order-agent.js');
      
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
      const { startWorkOrderAgent } = await import('../work-order-agent.js');
      
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
      const { startWorkOrderAgent } = await import('../work-order-agent.js');

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
    const {
      shouldStopForMaxIterations,
      shouldContinueLoop,
      shouldSleepBetweenIterations,
    } = jest.requireActual('../work-order-agent.js');

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
});
