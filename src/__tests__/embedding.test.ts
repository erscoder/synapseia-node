import { jest } from '@jest/globals';
/**
 * Tests for embedding.ts (A17)
 * Tests for generateEmbedding, cosineSimilarity, similaritySearch
 */

import {
  generateEmbedding,
  cosineSimilarity,
  similaritySearch,
  type Document,
  type SimilarityResult,
} from '../shared/embedding.js';

// Mock fetch for Ollama API
global.fetch = jest.fn() as any;

describe('generateEmbedding', () => {
  const mockEmbedding: number[] = [0.1, 0.2, -0.3, 0.4, 0.5];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should generate embedding for text with default model', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: mockEmbedding }),
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    const result = await generateEmbedding('test text');

    expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'locusai/all-minilm-l6-v2', prompt: 'test text' }),
    });

    expect(result).toEqual(mockEmbedding);
  });

  it('should generate embedding for text with custom model', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: mockEmbedding }),
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    const result = await generateEmbedding('test text', 'custom-model');

    expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'custom-model', prompt: 'test text' }),
    });

    expect(result).toEqual(mockEmbedding);
  });

  it('should handle response with different embedding dimensions', async () => {
    const largeEmbedding = Array.from({ length: 384 }, () => Math.random());
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: largeEmbedding }),
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    const result = await generateEmbedding('long text');

    expect(result).toHaveLength(384);
    expect(result).toEqual(largeEmbedding);
  });

  it('should throw on API error', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(generateEmbedding('test')).rejects.toThrow('Ollama embeddings API error');
  });

  it('should throw on connection error with helpful message', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(generateEmbedding('test')).rejects.toThrow('Cannot connect to Ollama');
  });

  it('should handle empty text', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: mockEmbedding }),
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    const result = await generateEmbedding('');

    expect(result).toEqual(mockEmbedding);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        body: JSON.stringify({ model: 'locusai/all-minilm-l6-v2', prompt: '' }),
      }),
    );
  });

  it('should handle special characters in text', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: mockEmbedding }),
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    const result = await generateEmbedding('Test with "quotes" and \'apostrophes\'\nAnd newlines!');

    expect(result).toEqual(mockEmbedding);
  });
});

describe('cosineSimilarity', () => {
  it('should calculate cosine similarity correctly', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const expected =
      (1 * 4 + 2 * 5 + 3 * 6) /
      (Math.sqrt(1 + 4 + 9) * Math.sqrt(16 + 25 + 36));
    const result = cosineSimilarity(a, b);

    expect(result).toBeCloseTo(expected, 10);
  });

  it('should return 1 for identical vectors', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    const result = cosineSimilarity(a, b);

    expect(result).toBeCloseTo(1, 10);
  });

  it('should return -1 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    const result = cosineSimilarity(a, b);

    expect(result).toBeCloseTo(-1, 10);
  });

  it('should return 0 for orthogonal vectors', () => {
    const a = [1, 0];
    const b = [0, 1];
    const result = cosineSimilarity(a, b);

    expect(result).toBe(0);
  });

  it('should return 0 for zero vector', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    const result = cosineSimilarity(a, b);

    expect(result).toBe(0);
  });

  it('should throw for vectors of different lengths', () => {
    const a = [1, 2, 3];
    const b = [1, 2];

    expect(() => cosineSimilarity(a, b)).toThrow('Vectors must have same length');
  });

  it('should throw for empty vectors', () => {
    const a: number[] = [];
    const b: number[] = [];

    expect(() => cosineSimilarity(a, b)).toThrow('Vectors must not be empty');
  });

  it('should handle normalized vectors', () => {
    const a = [0.5773502691896258, 0.5773502691896258, 0.5773502691896258]; // sqrt(1/3)
    const b = [0.2672612419124244, 0.5345224838248488, 0.8017837257372732]; // normalized [1,2,3]
    const result = cosineSimilarity(a, b);

    expect(result).toBeCloseTo(0.9258, 4);
  });

  it('should handle negative values', () => {
    const a = [-1, -2];
    const b = [-3, -4];
    const result = cosineSimilarity(a, b);

    expect(result).toBeGreaterThan(0);
    expect(result).toBeCloseTo(
      (-1 * -3 + -2 * -4) / (Math.sqrt(1 + 4) * Math.sqrt(9 + 16)),
      10,
    );
  });

  it('should handle mixed positive and negative values', () => {
    const a = [1, -2, 3];
    const b = [-1, 2, -3];
    const result = cosineSimilarity(a, b);

    expect(result).toBeCloseTo(-1, 10);
  });

  it('should handle large vectors efficiently', () => {
    const a = Array.from({ length: 1000 }, () => Math.random());
    const b = Array.from({ length: 1000 }, () => Math.random());
    const result = cosineSimilarity(a, b);

    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe('similaritySearch', () => {
  const documents: Document[] = [
    { id: '1', text: 'Artificial intelligence and machine learning' },
    { id: '2', text: 'Deep learning neural networks' },
    { id: '3', text: 'Cooking recipes and food preparation' },
    { id: '4', text: 'Natural language processing' },
    { id: '5', text: 'Machine learning algorithms' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return topK results sorted by score', async () => {
    // Mock embeddings - query should be similar to docs 1, 2, 4, 5
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: [1, 2, 3] }),
    };
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('embeddings')) {
        return Promise.resolve(mockResponse);
      }
      return Promise.resolve({ ok: true, json: () => ({}) });
    });

    const results = await similaritySearch('machine learning', documents, 3);

    expect(results).toHaveLength(3);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
  });

  it('should return empty array for empty documents', async () => {
    const results = await similaritySearch('query', [], 5);

    expect(results).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return empty array for topK <= 0', async () => {
    const results = await similaritySearch('query', documents, 0);

    expect(results).toHaveLength(0);
  });

  it('should return empty array for negative topK', async () => {
    const results = await similaritySearch('query', documents, -1);

    expect(results).toHaveLength(0);
  });

  it('should return all documents if topK > documents.length', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: [1, 2, 3] }),
    };
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('embeddings')) {
        return Promise.resolve(mockResponse);
      }
      return Promise.resolve({ ok: true, json: () => ({}) });
    });

    const results = await similaritySearch('query', documents, 100);

    expect(results).toHaveLength(documents.length);
  });

  it('should use default model when not specified', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: [1, 2, 3] }),
    };
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('embeddings')) {
        return Promise.resolve(mockResponse);
      }
      return Promise.resolve({ ok: true, json: () => ({}) });
    });

    await similaritySearch('query', documents, 1);

    // Should be called for query + 1 document
    expect((global.fetch as any).mock.calls.length).toBeGreaterThan(0);
  });

  it('should use custom model when specified', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: [1, 2, 3] }),
    };
    (global.fetch as any).mockImplementation((url: string, options: any) => {
      if (url.includes('embeddings')) {
        const body = JSON.parse(options.body);
        expect(body.model).toBe('custom-model');
        return Promise.resolve(mockResponse);
      }
      return Promise.resolve({ ok: true, json: () => ({}) });
    });

    await similaritySearch('query', documents, 1, 'custom-model');
  });

  it('should return results with correct structure', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: [1, 2, 3] }),
    };
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('embeddings')) {
        return Promise.resolve(mockResponse);
      }
      return Promise.resolve({ ok: true, json: () => ({}) });
    });

    const results = await similaritySearch('query', documents, 2);

    results.forEach((result: SimilarityResult) => {
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('score');
      expect(typeof result.score).toBe('number');
      expect(documents.find((d) => d.id === result.id)).toBeDefined();
    });
  });

  it('should handle single document', async () => {
    const singleDoc = [{ id: '1', text: 'single document' }];
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: [1, 2, 3] }),
    };
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('embeddings')) {
        return Promise.resolve(mockResponse);
      }
      return Promise.resolve({ ok: true, json: () => ({}) });
    });

    const results = await similaritySearch('query', singleDoc, 5);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('should propagate API errors', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Connection failed'));

    await expect(similaritySearch('query', documents, 1)).rejects.toThrow('Connection failed');
  });

  it('should return score between -1 and 1', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ embedding: [1, 2, 3] }),
    };
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('embeddings')) {
        return Promise.resolve(mockResponse);
      }
      return Promise.resolve({ ok: true, json: () => ({}) });
    });

    const results = await similaritySearch('query', documents, 1);

    results.forEach((result) => {
      expect(result.score).toBeGreaterThanOrEqual(-1);
      expect(result.score).toBeLessThanOrEqual(1);
    });
  });
});
