/**
 * Tests for QueryKgTool
 * Sprint C - ReAct Tool Calling
 */

import { QueryKgTool } from '../../tools/query-kg.tool';

// Mock the work-order-agent module
jest.mock('../../../work-order-agent', () => ({
  fetchKGraphContext: jest.fn(),
}));

describe('QueryKgTool', () => {
  let tool: QueryKgTool;

  beforeEach(() => {
    tool = new QueryKgTool();
    jest.clearAllMocks();
  });

  describe('definition', () => {
    it('should have correct tool definition', () => {
      expect(tool.def.name).toBe('query_knowledge_graph');
      expect(tool.def.description).toContain('knowledge graph');
      expect(tool.def.parameters.type).toBe('object');
      expect(tool.def.parameters.required).toContain('topic');
      expect(tool.def.parameters.properties.topic).toBeDefined();
      expect(tool.def.parameters.properties.missionId).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should call fetchKGraphContext with correct params (topic only)', async () => {
      const { fetchKGraphContext } = await import('../../../work-order-agent');
      (fetchKGraphContext as jest.Mock).mockResolvedValue('Knowledge graph context');

      const result = await tool.execute({ topic: 'quantum computing' }, 'http://localhost:3000');

      expect(fetchKGraphContext).toHaveBeenCalledWith('http://localhost:3000', 'quantum computing', undefined);
      expect(result).toBe('Knowledge graph context');
    });

    it('should pass missionId when provided', async () => {
      const { fetchKGraphContext } = await import('../../../work-order-agent');
      (fetchKGraphContext as jest.Mock).mockResolvedValue('Scoped context');

      await tool.execute({ topic: 'ai', missionId: 'mission-123' }, 'http://localhost:3000');

      expect(fetchKGraphContext).toHaveBeenCalledWith('http://localhost:3000', 'ai', 'mission-123');
    });

    it('should handle errors gracefully', async () => {
      const { fetchKGraphContext } = await import('../../../work-order-agent');
      (fetchKGraphContext as jest.Mock).mockRejectedValue(new Error('KG service unavailable'));

      await expect(tool.execute({ topic: 'test' }, 'http://localhost:3000')).rejects.toThrow('KG service unavailable');
    });

    it('should handle empty context result', async () => {
      const { fetchKGraphContext } = await import('../../../work-order-agent');
      (fetchKGraphContext as jest.Mock).mockResolvedValue('');

      const result = await tool.execute({ topic: 'unknown topic' }, 'http://localhost:3000');

      expect(result).toBe('');
    });
  });
});
