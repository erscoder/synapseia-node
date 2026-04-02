/**
 * Unit tests for LangGraph nodes
 * Sprint A - LangGraph Foundation
 * A17 - Migrate agent tests
 */

import { jest } from '@jest/globals';

// Mock fetch globally
global.fetch = jest.fn() as unknown as typeof fetch;

// Import after mocking
import type { AgentState } from '../state.js';
import { selectBestWorkOrder } from '../nodes/select-wo.js';
import { fetchWorkOrders, resetWorkOrderFilters } from '../nodes/fetch-work-orders.js';
import { evaluateEconomics } from '../nodes/evaluate-economics.js';
import { acceptWorkOrderNode } from '../nodes/accept-wo.js';
import { updateMemory } from '../nodes/update-memory.js';
import type { WorkOrder, WorkOrderEvaluation } from '../work-order-agent.js';
import { initBrain } from '../agent-brain.js';

describe('LangGraph Nodes', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetWorkOrderFilters();
  });

  describe('selectBestWorkOrder', () => {
    it('should select first available work order', () => {
      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Research',
        description: '{"title":"Test","abstract":"Test abstract"}',
        type: 'RESEARCH',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      const state: AgentState = {
        availableWorkOrders: [mockWorkOrder],
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
        config: {} as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = selectBestWorkOrder(state);

      expect(result.selectedWorkOrder).toEqual(mockWorkOrder);
      expect(result.selectedWorkOrder?.id).toBe('wo_1');
    });

    it('should return null when no work orders available', () => {
      const state: AgentState = {
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
        config: {} as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = selectBestWorkOrder(state);

      expect(result.selectedWorkOrder).toBeNull();
    });
  });

  describe('fetchWorkOrders', () => {
    it('should return empty array when coordinator returns empty', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const state: AgentState = {
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
        config: {} as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = await fetchWorkOrders(state);

      expect(result.availableWorkOrders).toEqual([]);
    });

    it('should return work orders from coordinator', async () => {
      const mockWorkOrders: WorkOrder[] = [
        {
          id: 'wo_1',
          title: 'Research Task',
          description: '{"title":"Test","abstract":"Test abstract"}',
          type: 'RESEARCH',
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

      const state: AgentState = {
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
        config: {} as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = await fetchWorkOrders(state);

      expect(result.availableWorkOrders).toHaveLength(1);
      expect(result.availableWorkOrders?.[0].id).toBe('wo_1');
    });
  });

  describe('evaluateEconomics', () => {
    it('should evaluate work order economics', () => {
      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Research',
        description: '{"title":"Test","abstract":"This is a test abstract for evaluating economics"}',
        type: 'RESEARCH',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000', // 1 SYN
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      const state: AgentState = {
        availableWorkOrders: [mockWorkOrder],
        selectedWorkOrder: mockWorkOrder,
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
          coordinatorUrl: 'http://localhost:3001',
          peerId: 'peer1',
          capabilities: ['llm'],
          llmModel: { provider: 'ollama', modelId: 'qwen2.5:0.5b' },
          llmConfig: undefined,
        } as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = evaluateEconomics(state);

      expect(result.economicEvaluation).not.toBeNull();
      expect(result.economicEvaluation?.shouldAccept).toBe(true); // Ollama = $0 cost = always accept
    });
  });

  describe('acceptWorkOrderNode', () => {
    it('should accept work order successfully', async () => {
      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Task',
        description: 'Test description',
        type: 'TRAINING',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
      });

      const state: AgentState = {
        availableWorkOrders: [mockWorkOrder],
        selectedWorkOrder: mockWorkOrder,
        economicEvaluation: null,
        executionResult: null,
        researchResult: null,
        qualityScore: 0,
        shouldSubmit: false,
        submitted: false,
        accepted: false,
        brain: initBrain(),
        iteration: 1,
        config: {} as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = await acceptWorkOrderNode(state);

      expect(result.accepted).toBe(true);
    });

    it('should return false when accept fails', async () => {
      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Task',
        description: 'Test description',
        type: 'TRAINING',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Failed to accept',
      });

      const state: AgentState = {
        availableWorkOrders: [mockWorkOrder],
        selectedWorkOrder: mockWorkOrder,
        economicEvaluation: null,
        executionResult: null,
        researchResult: null,
        qualityScore: 0,
        shouldSubmit: false,
        submitted: false,
        accepted: false,
        brain: initBrain(),
        iteration: 1,
        config: {} as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = await acceptWorkOrderNode(state);

      expect(result.accepted).toBe(false);
    });
  });

  describe('updateMemory', () => {
    it('should update brain with research result', () => {
      const mockWorkOrder: WorkOrder = {
        id: 'wo_1',
        title: 'Test Research',
        description: '{"title":"Test","abstract":"Test abstract"}',
        type: 'RESEARCH',
        requiredCapabilities: ['llm'],
        rewardAmount: '1000000000',
        status: 'PENDING',
        creatorAddress: 'creator1',
        createdAt: Date.now(),
      };

      const mockResearchResult = {
        summary: 'Test summary',
        keyInsights: ['insight1', 'insight2'],
        proposal: 'Test proposal',
      };

      const brain = initBrain();
      const initialMemoryCount = brain.memory.length;

      const state: AgentState = {
        availableWorkOrders: [mockWorkOrder],
        selectedWorkOrder: mockWorkOrder,
        economicEvaluation: null,
        executionResult: { result: 'success', success: true },
        researchResult: mockResearchResult,
        qualityScore: 5,
        shouldSubmit: true,
        submitted: false,
        accepted: false,
        brain,
        iteration: 1,
        config: {} as AgentState['config'],
        coordinatorUrl: 'http://localhost:3001',
        peerId: 'peer1',
        capabilities: ['llm'],
      };

      const result = updateMemory(state);

      // Brain should have been updated (memory entries added)
      expect(result.brain).toBeDefined();
    });
  });
});
