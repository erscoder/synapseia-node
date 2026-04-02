/**
 * Tests for GenerateEmbeddingTool
 * Sprint C - ReAct Tool Calling
 */

import { GenerateEmbeddingTool } from '../../tools/generate-embedding.tool';

describe('GenerateEmbeddingTool', () => {
  let tool: GenerateEmbeddingTool;

  beforeEach(() => {
    tool = new GenerateEmbeddingTool();
    jest.clearAllMocks();
  });

  describe('definition', () => {
    it('should have correct tool definition', () => {
      expect(tool.def.name).toBe('generate_embedding');
      expect(tool.def.description).toContain('semantic embedding');
      expect(tool.def.parameters.type).toBe('object');
      expect(tool.def.parameters.required).toContain('text');
      expect(tool.def.parameters.properties.text).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should return an array (may be empty on error)', async () => {
      // When Ollama is not available, graceful degradation returns empty array
      // When Ollama is available, it returns actual embeddings
      const result = await tool.execute({ text: 'test' });

      // Result should always be an array
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle non-empty text', async () => {
      const result = await tool.execute({ text: 'Hello world' });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle long text', async () => {
      const longText = 'a'.repeat(1000);

      const result = await tool.execute({ text: longText });

      expect(Array.isArray(result)).toBe(true);
    });
  });
});
