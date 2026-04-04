/**
 * Task Router Tests
 * Sprint D — A2A Server
 */

import { TaskRouter } from '../task-router';
import { PeerReviewHandler } from '../handlers/peer-review.handler';
import { EmbeddingHandler } from '../handlers/embedding.handler';
import { HealthCheckHandler } from '../handlers/health-check.handler';
import { DelegateResearchHandler } from '../handlers/delegate-research.handler';
import { KnowledgeQueryHandler } from '../handlers/knowledge-query.handler';
import { AgentCardService } from '../agent-card.service';
import type { A2ATask } from '../types';

// Mock handlers
const mockPeerReviewHandler = {
  handle: jest.fn(),
};
const mockEmbeddingHandler = {
  handle: jest.fn(),
};
const mockDelegateResearchHandler = {
  handle: jest.fn(),
};
const mockKnowledgeQueryHandler = {
  handle: jest.fn(),
};

function makeCardService(): AgentCardService {
  const service = new AgentCardService();
  service.configure({
    peerId: 'test-peer-id-12345678',
    tier: 1,
    domain: 'test',
    capabilities: [],
    a2aPort: 8080,
  });
  return service;
}

function makeTask(type: A2ATask['type'], payload: Record<string, unknown> = {}): A2ATask {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    type,
    payload,
    senderPeerId: 'sender',
    timestamp: Date.now(),
    nonce: Math.random().toString(36).slice(2),
    signature: 'sig',
  };
}

describe('TaskRouter', () => {
  let router: TaskRouter;
  let healthCheckHandler: HealthCheckHandler;

  beforeEach(() => {
    jest.clearAllMocks();

    const cardService = makeCardService();
    healthCheckHandler = new HealthCheckHandler(cardService);

    router = new TaskRouter(
      mockPeerReviewHandler as unknown as PeerReviewHandler,
      mockEmbeddingHandler as unknown as EmbeddingHandler,
      healthCheckHandler,
      mockDelegateResearchHandler as unknown as DelegateResearchHandler,
      mockKnowledgeQueryHandler as unknown as KnowledgeQueryHandler,
    );
  });

  describe('route', () => {
    it('should route health_check to HealthCheckHandler', async () => {
      const task = makeTask('health_check');
      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(result.taskId).toBe(task.id);
      expect(result.data).toHaveProperty('status', 'ok');
      expect(result.data).toHaveProperty('uptime');
      expect(result.data).toHaveProperty('capabilities');
      expect(result.processingMs).toBeGreaterThanOrEqual(0);
    });

    it('should route peer_review to PeerReviewHandler', async () => {
      const task = makeTask('peer_review', {
        submission: 'Test submission content',
        roundId: 'round-1',
      });
      mockPeerReviewHandler.handle.mockResolvedValue({ scores: { accuracy: 7 } });

      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(mockPeerReviewHandler.handle).toHaveBeenCalledWith(task.payload);
    });

    it('should route embedding_request to EmbeddingHandler', async () => {
      const task = makeTask('embedding_request', { text: 'hello world' });
      mockEmbeddingHandler.handle.mockResolvedValue({ embedding: [0.1, 0.2] });

      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(mockEmbeddingHandler.handle).toHaveBeenCalledWith(task.payload);
    });

    it('should route delegate_research to DelegateResearchHandler', async () => {
      const task = makeTask('delegate_research', { workOrder: { id: 'wo-1' } });
      mockDelegateResearchHandler.handle.mockResolvedValue({ summary: 'done' });

      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(mockDelegateResearchHandler.handle).toHaveBeenCalledWith(task.payload);
    });

    it('should route knowledge_query to KnowledgeQueryHandler', async () => {
      const task = makeTask('knowledge_query', { topic: 'BRCA1 cancer research' });
      (mockKnowledgeQueryHandler.handle as jest.Mock).mockResolvedValueOnce({
        context: 'Found 3 papers about BRCA1...',
        topic: 'BRCA1 cancer research',
        missionId: null,
      });

      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(mockKnowledgeQueryHandler.handle).toHaveBeenCalledWith(task.payload);
    });

    it('should include taskId in result', async () => {
      const task = makeTask('health_check');

      const result = await router.route(task);

      expect(result.taskId).toBe(task.id);
    });

    it('should record processing time', async () => {
      const task = makeTask('health_check');

      const result = await router.route(task);

      expect(typeof result.processingMs).toBe('number');
      expect(result.processingMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle handler throws gracefully', async () => {
      mockPeerReviewHandler.handle.mockRejectedValue(new Error('Handler error'));
      const task = makeTask('peer_review', { submission: 'test' });

      const result = await router.route(task);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Handler error');
    });
  });
});
