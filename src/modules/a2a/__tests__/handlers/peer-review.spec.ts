/**
 * Peer Review Handler Tests
 * Sprint D — A2A Server
 */

import { PeerReviewHandler } from '../../handlers/peer-review.handler';

// Mock ReviewAgentHelper (not actually used in inline scoring path)
const mockReviewAgent = {
  scoreSubmission: jest.fn(),
};

describe('PeerReviewHandler', () => {
  let handler: PeerReviewHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new PeerReviewHandler();
  });

  describe('handle', () => {
    it('should score a plain text submission', async () => {
      const result = await handler.handle({
        submission: 'This is a test research submission about machine learning.',
        roundId: 'round-1',
      }) as Record<string, unknown>;

      expect(result).toHaveProperty('scores');
      const scores = result['scores'] as Record<string, unknown>;
      expect(scores).toHaveProperty('accuracy');
      expect(scores).toHaveProperty('novelty');
      expect(scores).toHaveProperty('methodology');
      expect(scores).toHaveProperty('conclusions');
      expect(scores).toHaveProperty('commentary');
      expect(typeof scores['commentary']).toBe('string');
    });

    it('should score a JSON submission', async () => {
      const result = await handler.handle({
        submission: JSON.stringify({
          id: 'sub-1',
          roundId: 'round-1',
          nodeId: 'node-1',
          summary: 'A detailed research summary about neural networks.',
          keyInsights: ['Insight 1', 'Insight 2', 'Insight 3'],
          title: 'Neural Network Research',
        }),
        roundId: 'round-1',
      }) as Record<string, unknown>;

      expect(result).toHaveProperty('scores');
      const scores = result['scores'] as Record<string, unknown>;
      expect(scores['accuracy']).toBeGreaterThan(0);
    });

    it('should throw if submission is missing', async () => {
      await expect(
        handler.handle({ roundId: 'round-1' }),
      ).rejects.toThrow('peer_review payload requires submission');
    });

    it('should handle empty keyInsights array', async () => {
      const result = await handler.handle({
        submission: 'Short summary',
        roundId: 'round-1',
      }) as Record<string, unknown>;

      expect(result).toHaveProperty('scores');
    });

    it('should include commentary in result', async () => {
      const result = await handler.handle({
        submission: 'A very long and detailed research submission that goes into depth about methodology and findings, showing strong evidence and clear conclusions.',
        roundId: 'round-1',
      }) as Record<string, unknown>;

      expect(result).toHaveProperty('commentary');
      expect(typeof result['commentary']).toBe('string');
      expect((result['commentary'] as string).length).toBeGreaterThan(0);
    });
  });
});
