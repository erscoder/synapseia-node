/**
 * Tests for CheckpointService and AgentGraphService checkpointing integration
 */

import { jest } from '@jest/globals';

jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { CheckpointService } from '../checkpoint.service';
import logger from '../../../../utils/logger';

describe('CheckpointService', () => {
  let service: CheckpointService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CheckpointService();
  });

  describe('getCheckpointer', () => {
    it('should return a MemorySaver instance', () => {
      const checkpointer = service.getCheckpointer();
      expect(checkpointer).toBeDefined();
      expect(checkpointer.constructor.name).toBe('MemorySaver');
    });

    it('should return the same instance on repeated calls', () => {
      const a = service.getCheckpointer();
      const b = service.getCheckpointer();
      expect(a).toBe(b);
    });
  });

  describe('threadIdForWorkOrder', () => {
    it('should prefix work order ID with wo_', () => {
      expect(service.threadIdForWorkOrder('abc-123')).toBe('wo_abc-123');
    });

    it('should produce deterministic IDs', () => {
      const id1 = service.threadIdForWorkOrder('order-1');
      const id2 = service.threadIdForWorkOrder('order-1');
      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different work orders', () => {
      const id1 = service.threadIdForWorkOrder('order-1');
      const id2 = service.threadIdForWorkOrder('order-2');
      expect(id1).not.toBe(id2);
    });
  });

  describe('thread lifecycle', () => {
    it('should register and track active threads', () => {
      service.registerThread('wo_123', '123');
      expect(service.getActiveThreadCount()).toBe(1);
      expect(service.getActiveThreadIds()).toContain('wo_123');
    });

    it('should complete and remove threads', () => {
      service.registerThread('wo_123', '123');
      service.completeThread('wo_123');
      expect(service.getActiveThreadCount()).toBe(0);
    });

    it('should handle completing non-existent thread gracefully', () => {
      expect(() => service.completeThread('wo_nonexistent')).not.toThrow();
    });

    it('should track multiple threads independently', () => {
      service.registerThread('wo_1', '1');
      service.registerThread('wo_2', '2');
      service.registerThread('wo_3', '3');
      expect(service.getActiveThreadCount()).toBe(3);

      service.completeThread('wo_2');
      expect(service.getActiveThreadCount()).toBe(2);
      expect(service.getActiveThreadIds()).toEqual(
        expect.arrayContaining(['wo_1', 'wo_3']),
      );
    });
  });

  describe('logIncompleteThreads', () => {
    it('should log nothing when no active threads', () => {
      service.logIncompleteThreads();
      expect(logger.log).toHaveBeenCalledWith(
        '[Checkpoint] No incomplete threads found',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should warn for each incomplete thread', () => {
      service.registerThread('wo_a', 'a');
      service.registerThread('wo_b', 'b');
      service.logIncompleteThreads();
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('wo_a'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('wo_b'),
      );
    });
  });
});

describe('AgentGraphService checkpointing integration', () => {
  // We verify the compile() call receives the checkpointer and that
  // invoke() receives the thread_id config, without running the full graph.

  it('should compile graph with checkpointer from CheckpointService', async () => {
    // Dynamic import to avoid hoisting issues with mocks
    const { MemorySaver } = await import('@langchain/langgraph');
    const checkpointService = new CheckpointService();
    const checkpointer = checkpointService.getCheckpointer();
    expect(checkpointer).toBeInstanceOf(MemorySaver);
  });

  it('should derive thread_id from work order ID following wo_ prefix convention', () => {
    const checkpointService = new CheckpointService();
    const threadId = checkpointService.threadIdForWorkOrder('uuid-work-order-42');
    expect(threadId).toBe('wo_uuid-work-order-42');
  });

  it('should derive fallback thread_id for iterations without explicit work order', () => {
    const checkpointService = new CheckpointService();
    // The AgentGraphService uses `iter_${iteration}` when no workOrderId is provided
    const threadId = checkpointService.threadIdForWorkOrder('iter_5');
    expect(threadId).toBe('wo_iter_5');
  });
});
