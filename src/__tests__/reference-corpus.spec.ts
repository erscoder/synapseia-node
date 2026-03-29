import { jest } from '@jest/globals';
import { _test } from '../modules/agent/work-order-agent.js';

// Mock fetch globally
global.fetch = jest.fn() as any;

describe('Reference Corpus Context Fetching', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('fetchReferenceContext', () => {
    it('should fetch reference context from coordinator for a topic', async () => {
      const mockDocs = [
        {
          id: 'ref_1',
          title: 'Machine Learning Fundamentals',
          content: 'Core concepts of ML...',
          score: 9.5,
          topic: 'machine-learning',
          tags: ['ml', 'fundamentals'],
        },
        {
          id: 'ref_2',
          title: 'Deep Learning Architectures',
          content: 'Various neural network architectures...',
          score: 9.0,
          topic: 'machine-learning',
          tags: ['deep-learning', 'neural-networks'],
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockDocs,
      });

      const context = await _test.fetchReferenceContext(
        'http://localhost:3001',
        'machine-learning'
      );

      expect(context).toContain('Machine Learning Fundamentals');
      expect(context).toContain('score: 9.5');
      expect(context).toContain('Deep Learning Architectures');
      expect(context).toContain('score: 9');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/corpus/context?topic=machine-learning&limit=5'
      );
    });

    it('should return empty string if no documents found', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const context = await _test.fetchReferenceContext(
        'http://localhost:3001',
        'unknown-topic'
      );

      expect(context).toBe('');
    });

    it('should gracefully handle API errors', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const context = await _test.fetchReferenceContext(
        'http://localhost:3001',
        'machine-learning'
      );

      expect(context).toBe('');
    });

    it('should gracefully handle non-200 responses', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const context = await _test.fetchReferenceContext(
        'http://localhost:3001',
        'machine-learning'
      );

      expect(context).toBe('');
    });

    it('should encode topic parameter properly', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await _test.fetchReferenceContext(
        'http://localhost:3001',
        'quantum computing'
      );

      // Topic should be URL encoded
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/corpus/context?topic=quantum%20computing&limit=5'
      );
    });

    it('should format reference context correctly with markdown', async () => {
      const mockDocs = [
        {
          id: 'ref_1',
          title: 'AI Safety',
          content: 'Safety mechanisms...',
          score: 8.5,
          topic: 'ai-safety',
          tags: ['safety'],
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockDocs,
      });

      const context = await _test.fetchReferenceContext(
        'http://localhost:3001',
        'ai-safety'
      );

      // Check markdown formatting
      expect(context).toContain('### Previous Discovery (score: 8.5/10)');
      expect(context).toContain('**AI Safety**');
      expect(context).toContain('Safety mechanisms...');
    });
  });

  describe('buildResearchPrompt with reference context', () => {
    it('should include reference context in the prompt if provided', () => {
      const payload = {
        title: 'Advanced Deep Learning',
        abstract: 'A paper on deep learning...',
      };

      const referenceContext = `### Previous Discovery (score: 9.0/10)
**Foundational ML Work**
Earlier research showed...`;

      const prompt = _test.buildResearchPrompt(payload, referenceContext);

      expect(prompt).toContain('You have access to previous discoveries from the network');
      expect(prompt).toContain('Foundational ML Work');
      expect(prompt).toContain('Build upon these findings');
      expect(prompt).toContain('Don\'t repeat what\'s already known');
    });

    it('should build prompt without context if none provided', () => {
      const payload = {
        title: 'Advanced Deep Learning',
        abstract: 'A paper on deep learning...',
      };

      const prompt = _test.buildResearchPrompt(payload);

      expect(prompt).toContain('You are an expert research analyst');
      expect(prompt).not.toContain('previous discoveries from the network');
      expect(prompt).toContain('Title: Advanced Deep Learning');
    });

    it('should maintain all required fields in prompt', () => {
      const payload = {
        title: 'Paper Title',
        abstract: 'Paper abstract...',
      };

      const prompt = _test.buildResearchPrompt(payload);

      expect(prompt).toContain('summary');
      expect(prompt).toContain('keyInsights');
      expect(prompt).toContain('proposal');
      expect(prompt).toContain('JSON object');
    });
  });
});
