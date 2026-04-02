/**
 * Tests for SearchCorpusTool
 * Sprint C - ReAct Tool Calling
 */

import { SearchCorpusTool } from '../../tools/search-corpus.tool';

// Mock the work-order-agent module
jest.mock('../../../work-order-agent', () => ({
  fetchReferenceContext: jest.fn(),
}));

describe('SearchCorpusTool', () => {
  let tool: SearchCorpusTool;

  beforeEach(() => {
    tool = new SearchCorpusTool();
    jest.clearAllMocks();
  });

  describe('definition', () => {
    it('should have correct tool definition', () => {
      expect(tool.def.name).toBe('search_reference_corpus');
      expect(tool.def.description).toContain('Synapseia research corpus');
      expect(tool.def.parameters.type).toBe('object');
      expect(tool.def.parameters.required).toContain('topic');
      expect(tool.def.parameters.properties.topic).toBeDefined();
      expect(tool.def.parameters.properties.limit).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should call fetchReferenceContext with correct params', async () => {
      const { fetchReferenceContext } = await import('../../../work-order-agent');
      (fetchReferenceContext as jest.Mock).mockResolvedValue(['result1', 'result2']);

      const result = await tool.execute({ topic: 'machine learning' }, 'http://localhost:3000');

      expect(fetchReferenceContext).toHaveBeenCalledWith('http://localhost:3000', 'machine learning');
      expect(result).toEqual(['result1', 'result2']);
    });

    it('should ignore limit parameter (hardcoded in implementation)', async () => {
      const { fetchReferenceContext } = await import('../../../work-order-agent');
      (fetchReferenceContext as jest.Mock).mockResolvedValue([]);

      await tool.execute({ topic: 'ai', limit: 10 }, 'http://localhost:3000');

      // limit is ignored since fetchReferenceContext only takes 2 args
      expect(fetchReferenceContext).toHaveBeenCalledWith('http://localhost:3000', 'ai');
    });

    it('should handle errors gracefully', async () => {
      const { fetchReferenceContext } = await import('../../../work-order-agent');
      (fetchReferenceContext as jest.Mock).mockRejectedValue(new Error('Network error'));

      await expect(tool.execute({ topic: 'test' }, 'http://localhost:3000')).rejects.toThrow('Network error');
    });

    it('should handle empty results', async () => {
      const { fetchReferenceContext } = await import('../../../work-order-agent');
      (fetchReferenceContext as jest.Mock).mockResolvedValue([]);

      const result = await tool.execute({ topic: 'obscure topic' }, 'http://localhost:3000');

      expect(result).toEqual([]);
    });
  });
});
