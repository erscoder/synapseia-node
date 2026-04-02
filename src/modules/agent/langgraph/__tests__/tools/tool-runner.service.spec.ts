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

  describe('run - unknown tool', () => {
    it('should return error for unknown tool', async () => {
      const call: ToolCall = {
        toolName: 'unknown_tool',
        params: {},
      };

      const result = await service.run(call);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown tool: unknown_tool');
    });
  });
});
