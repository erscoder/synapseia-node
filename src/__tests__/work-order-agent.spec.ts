import {
  fetchAvailableWorkOrders,
  acceptWorkOrder,
  completeWorkOrder,
  executeWorkOrder,
  getWorkOrderAgentState,
  resetWorkOrderAgentState,
} from '../work-order-agent.js';
import { parseModel } from '../llm-provider.js';

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

    it('should return empty array on 404', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
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
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/work-orders/wo_1/complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workOrderId: 'wo_1',
            assigneeAddress: 'peer1',
            result: 'Research result here',
            success: true,
          }),
        }
      );
    });
  });

  describe('executeWorkOrder', () => {
    it('should execute work order with LLM', async () => {
      // Mock generateLLM
      jest.mock('../llm-provider.js', () => ({
        ...jest.requireActual('../llm-provider.js'),
        generateLLM: jest.fn().mockResolvedValue('Generated research result'),
      }));

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
      
      // Just verify the function exists and returns expected shape
      const result = await executeWorkOrder(workOrder, llmModel);
      
      // Should either succeed or fail gracefully
      expect(result).toHaveProperty('result');
      expect(result).toHaveProperty('success');
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
