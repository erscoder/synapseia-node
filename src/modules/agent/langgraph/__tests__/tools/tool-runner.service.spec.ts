/**
 * Tests for ToolRunnerService
 * Sprint C - ReAct Tool Calling
 */

import { ToolRunnerService } from '../../tools/tool-runner.service';
import type { ToolCall } from '../../tools/types';

// Mock the tool classes
const mockSearchCorpusTool = {
  execute: jest.fn(),
};

const mockQueryKgTool = {
  execute: jest.fn(),
};

const mockGenerateEmbeddingTool = {
  execute: jest.fn(),
};

describe('ToolRunnerService', () => {
  let service: ToolRunnerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ToolRunnerService(
      mockSearchCorpusTool as any,
      mockQueryKgTool as any,
      mockGenerateEmbeddingTool as any,
    );
  });

  describe('createExecutionContext', () => {
    it('should return context with zero call count', () => {
      const ctx = service.createExecutionContext();

      expect(ctx.callCount).toBe(0);
      expect(ctx.maxCalls).toBe(5);
    });
  });

  describe('run - search_reference_corpus', () => {
    it('should execute search corpus tool successfully', async () => {
      const mockResults = [{ title: 'Paper 1', score: 0.9 }];
      mockSearchCorpusTool.execute.mockResolvedValue(mockResults);

      const call: ToolCall = {
        toolName: 'search_reference_corpus',
        params: { topic: 'machine learning', limit: 5, coordinatorUrl: 'http://localhost:3000' },
      };

      const result = await service.run(call);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResults);
      expect(result.error).toBeUndefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should require coordinatorUrl for search corpus', async () => {
      const call: ToolCall = {
        toolName: 'search_reference_corpus',
        params: { topic: 'ai' },
      };

      const result = await service.run(call);

      expect(result.success).toBe(false);
      expect(result.error).toContain('coordinatorUrl is required');
    });

    it('should handle search corpus errors', async () => {
      mockSearchCorpusTool.execute.mockRejectedValue(new Error('Network timeout'));

      const call: ToolCall = {
        toolName: 'search_reference_corpus',
        params: { topic: 'ai', coordinatorUrl: 'http://localhost:3000' },
      };

      const result = await service.run(call);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('run - query_knowledge_graph', () => {
    it('should execute query KG tool successfully', async () => {
      const mockContext = 'Knowledge graph context about AI';
      mockQueryKgTool.execute.mockResolvedValue(mockContext);

      const call: ToolCall = {
        toolName: 'query_knowledge_graph',
        params: { topic: 'artificial intelligence', coordinatorUrl: 'http://localhost:3000' },
      };

      const result = await service.run(call);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockContext);
      expect(mockQueryKgTool.execute).toHaveBeenCalledWith(
        { topic: 'artificial intelligence' },
        'http://localhost:3000',
      );
    });

    it('should pass missionId when provided', async () => {
      mockQueryKgTool.execute.mockResolvedValue('Scoped context');

      const call: ToolCall = {
        toolName: 'query_knowledge_graph',
        params: {
          topic: 'neural networks',
          missionId: 'mission-456',
          coordinatorUrl: 'http://localhost:3000',
        },
      };

      await service.run(call);

      expect(mockQueryKgTool.execute).toHaveBeenCalledWith(
        { topic: 'neural networks', missionId: 'mission-456' },
        'http://localhost:3000',
      );
    });

    it('should require coordinatorUrl for query KG', async () => {
      const call: ToolCall = {
        toolName: 'query_knowledge_graph',
        params: { topic: 'ai' },
      };

      const result = await service.run(call);

      expect(result.success).toBe(false);
      expect(result.error).toContain('coordinatorUrl is required');
    });
  });

  describe('run - generate_embedding', () => {
    it('should execute generate embedding tool successfully', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockGenerateEmbeddingTool.execute.mockResolvedValue(mockEmbedding);

      const call: ToolCall = {
        toolName: 'generate_embedding',
        params: { text: 'Hello world' },
      };

      const result = await service.run(call);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockEmbedding);
      expect(mockGenerateEmbeddingTool.execute).toHaveBeenCalledWith({ text: 'Hello world' });
    });

    it('should handle embedding generation errors', async () => {
      mockGenerateEmbeddingTool.execute.mockRejectedValue(new Error('Model not loaded'));

      const call: ToolCall = {
        toolName: 'generate_embedding',
        params: { text: 'test' },
      };

      const result = await service.run(call);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Model not loaded');
    });
  });

  describe('run - confused-deputy allowlist', () => {
    it('rejects a tool name not in the registered set', async () => {
      const call: ToolCall = {
        toolName: 'unknown_tool',
        params: {},
      };

      const result = await service.run(call);

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "Tool 'unknown_tool' is not registered for this execution context",
      );
      // Error lists the legitimate set so the ReAct loop can self-correct.
      expect(result.error).toContain('search_reference_corpus');
    });

    it('rejects an A2A tool when its helper was not injected (A2A off)', async () => {
      // `service` is built WITHOUT delegateToPeerTool / requestPeerReviewTool.
      for (const toolName of ['delegate_to_peer', 'request_peer_review']) {
        const result = await service.run({ toolName, params: {} } as ToolCall);
        expect(result.success).toBe(false);
        expect(result.error).toContain('is not registered for this execution context');
      }
    });

    it('allows an A2A tool only when its helper IS injected', async () => {
      const mockDelegate = { execute: jest.fn().mockResolvedValue({ ok: true }) };
      const a2aService = new ToolRunnerService(
        mockSearchCorpusTool as any,
        mockQueryKgTool as any,
        mockGenerateEmbeddingTool as any,
        mockDelegate as any,
      );

      const result = await a2aService.run({
        toolName: 'delegate_to_peer',
        params: {
          capability: 'analysis',
          taskType: 't',
          payload: {},
          ourPeerId: 'p1',
          ourPrivateKeyHex: 'deadbeef',
        },
      } as ToolCall);

      expect(result.success).toBe(true);
      expect(mockDelegate.execute).toHaveBeenCalledTimes(1);
    });

    it('still runs the always-registered tools after the allowlist gate', async () => {
      mockGenerateEmbeddingTool.execute.mockResolvedValue([0.1, 0.2]);
      const result = await service.run({
        toolName: 'generate_embedding',
        params: { text: 'hi' },
      });
      expect(result.success).toBe(true);
      expect(mockGenerateEmbeddingTool.execute).toHaveBeenCalledWith({ text: 'hi' });
    });
  });
});
