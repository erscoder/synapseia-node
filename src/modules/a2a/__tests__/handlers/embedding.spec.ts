/**
 * Embedding Handler Tests
 * Sprint D — A2A Server
 *
 * Note: These tests mock the Ollama dependency. In integration tests
 * with a live Ollama instance, the actual embedding would be generated.
 */

import { EmbeddingHandler } from '../../handlers/embedding.handler';

// Mock the shared embedding module
jest.mock('../../../../shared/embedding', () => ({
  EmbeddingHelper: jest.fn().mockImplementation(() => ({
    generateEmbedding: jest.fn(),
  })),
}));

describe('EmbeddingHandler', () => {
  let handler: EmbeddingHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new EmbeddingHandler();
  });

  describe('handle', () => {
    it('should throw if text is missing', async () => {
      await expect(handler.handle({})).rejects.toThrow(
        'embedding_request payload requires text',
      );
    });

    it('should throw if text is not a string', async () => {
      await expect(handler.handle({ text: 123 })).rejects.toThrow(
        'embedding_request payload requires text',
      );
    });

    it('should return error object if Ollama is unavailable', async () => {
      // Override the handler's EmbeddingHelper to throw
      const { EmbeddingHelper } = require('../../../../shared/embedding');
      (EmbeddingHelper as jest.Mock).mockImplementationOnce(() => ({
        generateEmbedding: jest.fn().mockRejectedValue(new Error('Connection refused')),
      }));

      const localHandler = new (require('../../handlers/embedding.handler').EmbeddingHandler)();
      const result = await localHandler.handle({ text: 'hello' }) as Record<string, unknown>;

      expect(result).toHaveProperty('error');
      expect(result['error']).toContain('Connection refused');
      expect(result['dimensions']).toBe(0);
    });

    it('should return embedding result with model and dimensions', async () => {
      // Override to return a mock embedding
      const { EmbeddingHelper } = require('../../../../shared/embedding');
      (EmbeddingHelper as jest.Mock).mockImplementationOnce(() => ({
        generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      }));

      const localHandler = new (require('../../handlers/embedding.handler').EmbeddingHandler)();
      const result = await localHandler.handle({ text: 'hello world' }) as Record<string, unknown>;

      expect(result).toHaveProperty('embedding');
      expect(Array.isArray(result['embedding'])).toBe(true);
      expect(result['dimensions']).toBe(4);
      expect(result['model']).toBe('locusai/all-minilm-l6-v2');
    });

    it('should use provided model', async () => {
      const { EmbeddingHelper } = require('../../../../shared/embedding');
      (EmbeddingHelper as jest.Mock).mockImplementationOnce(() => ({
        generateEmbedding: jest.fn().mockResolvedValue([0.5]),
      }));

      const localHandler = new (require('../../handlers/embedding.handler').EmbeddingHandler)();
      const result = await localHandler.handle({ text: 'test', model: 'custom/model' }) as Record<string, unknown>;

      expect(result['model']).toBe('custom/model');
    });
  });
});
