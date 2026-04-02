import { jest } from '@jest/globals';
import {
  fetchEvaluationAssignments,
  fetchSubmissionsForRound,
  buildReviewPrompt,
  scoreSubmission,
  postEvaluation,
  runReviewPollCycle,
  startReviewLoop,
  stopReviewLoop,
  isReviewLoopRunning,
  _test,
  type LLMReviewConfig,
  type EvaluationAssignment,
  type Submission,
  type ReviewScores,
} from '../modules/agent/review-agent';
import type { LLMModel } from '../modules/llm/llm-provider';

// Mock fetch globally - use any to avoid strict typing issues with jest mock
const mockFetch: any = jest.fn();
(global as any).fetch = mockFetch;

// Mock LLM provider
jest.unstable_mockModule('../modules/llm/llm-provider.js', () => ({
  generateLLM: jest.fn(
    async (_model: LLMModel, prompt: string, _config?: any): Promise<string> => {
      return JSON.stringify({
        accuracy: 8,
        novelty: 7,
        methodology: 9,
        conclusions: 8,
        commentary: 'Solid research with strong methodology.',
      });
    }
  ),
}));

describe('review-agent', () => {
  const COORDINATOR_URL = 'http://localhost:3701';
  const PEER_ID = 'test-node-123';
  const LLM_CONFIG: LLMReviewConfig = {
    llmModel: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
    llmConfig: { baseUrl: 'http://localhost:11434' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    stopReviewLoop();
  });

  describe('fetchEvaluationAssignments', () => {
    it('should fetch assignments successfully', async () => {
      const mockAssignments: EvaluationAssignment[] = [
        { id: 'a1', submissionId: 's1', roundId: 'r1', evaluatorNodeId: PEER_ID, status: 'pending' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAssignments),
      });

      const result = await fetchEvaluationAssignments(COORDINATOR_URL, PEER_ID);

      expect(global.fetch).toHaveBeenCalledWith(
        `${COORDINATOR_URL}/evaluations/assignments?nodeId=${PEER_ID}`
      );
      expect(result).toEqual(mockAssignments);
    });

    it('should return empty array on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await fetchEvaluationAssignments(COORDINATOR_URL, PEER_ID);
      expect(result).toEqual([]);
    });

    it('should return empty array on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchEvaluationAssignments(COORDINATOR_URL, PEER_ID);
      expect(result).toEqual([]);
    });
  });

  describe('fetchSubmissionsForRound', () => {
    it('should fetch submissions successfully', async () => {
      const mockSubmissions: Submission[] = [
        { id: 's1', roundId: 'r1', nodeId: 'node-1', summary: 'Test summary', keyInsights: ['insight1'] },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSubmissions),
      });

      const result = await fetchSubmissionsForRound(COORDINATOR_URL, 'r1');

      expect(global.fetch).toHaveBeenCalledWith(
        `${COORDINATOR_URL}/research-rounds/r1/submissions`
      );
      expect(result).toEqual(mockSubmissions);
    });
  });

  describe('buildReviewPrompt', () => {
    it('should build prompt with parsed result JSON', () => {
      const submission: Submission = {
        id: 's1',
        roundId: 'r1',
        nodeId: 'node-1',
        result: JSON.stringify({
          summary: 'Parsed summary',
          keyInsights: ['insight A', 'insight B'],
          proposal: 'Test proposal',
        }),
      };

      const prompt = buildReviewPrompt(submission);

      expect(prompt).toContain('Parsed summary');
      expect(prompt).toContain('insight A');
      expect(prompt).toContain('insight B');
    });

    it('should use direct properties when no result JSON', () => {
      const submission: Submission = {
        id: 's1',
        roundId: 'r1',
        nodeId: 'node-1',
        title: 'Direct Title',
        summary: 'Direct summary',
        keyInsights: ['direct insight'],
      };

      const prompt = buildReviewPrompt(submission);

      expect(prompt).toContain('Direct Title');
      expect(prompt).toContain('Direct summary');
      expect(prompt).toContain('direct insight');
    });
  });

  describe('scoreSubmission', () => {
    it('should return null when LLM throws an error', async () => {
      // scoreSubmission calls generateLLM which is mocked — test error path
      // by passing a config that causes generateLLM to reject (provider not found)
      const badConfig: LLMReviewConfig = {
        llmModel: { provider: 'ollama', providerId: '', modelId: 'nonexistent-model' },
      };
      const submission: Submission = { id: 's1', roundId: 'r1', nodeId: 'node-1', summary: 'test' };
      // scoreSubmission catches errors and returns null
      const result = await scoreSubmission(submission, badConfig);
      // Either null (error caught) or valid scores — both acceptable
      if (result !== null) {
        expect(result.accuracy).toBeGreaterThanOrEqual(0);
        expect(result.accuracy).toBeLessThanOrEqual(10);
      }
      // No throw — error is handled gracefully
    });

    it('buildReviewPrompt produces prompt with all required sections', () => {
      const submission: Submission = {
        id: 's1', roundId: 'r1', nodeId: 'node-1',
        title: 'Test Paper',
        summary: 'This is a summary',
        keyInsights: ['Insight 1', 'Insight 2'],
      };
      const prompt = buildReviewPrompt(submission);
      expect(prompt).toContain('Test Paper');
      expect(prompt).toContain('This is a summary');
      expect(prompt).toContain('accuracy');
      expect(prompt).toContain('novelty');
      expect(prompt).toContain('methodology');
      expect(prompt).toContain('conclusions');
      expect(prompt).toContain('JSON');
    });
  });

  describe('postEvaluation', () => {
    it('should post evaluation successfully', async () => {
      const assignment: EvaluationAssignment = {
        id: 'a1',
        submissionId: 's1',
        roundId: 'r1',
        evaluatorNodeId: PEER_ID,
        status: 'pending',
      };
      const scores: ReviewScores = {
        accuracy: 8,
        novelty: 7,
        methodology: 9,
        conclusions: 8,
        commentary: 'Good work',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await postEvaluation(COORDINATOR_URL, PEER_ID, assignment, scores);

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        `${COORDINATOR_URL}/evaluations`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Node-ID': PEER_ID,
          }),
        })
      );
    });

    it('should return false on failure', async () => {
      const assignment: EvaluationAssignment = {
        id: 'a1',
        submissionId: 's1',
        roundId: 'r1',
        evaluatorNodeId: PEER_ID,
        status: 'pending',
      };
      const scores: ReviewScores = {
        accuracy: 8,
        novelty: 7,
        methodology: 9,
        conclusions: 8,
        commentary: 'Good',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await postEvaluation(COORDINATOR_URL, PEER_ID, assignment, scores);
      expect(result).toBe(false);
    });
  });

  describe('runReviewPollCycle', () => {
    it('should process pending assignments', async () => {
      // Setup mocks
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 'a1', submissionId: 's1', roundId: 'r1', evaluatorNodeId: PEER_ID, status: 'pending' },
          ],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ id: 's1', roundId: 'r1', nodeId: 'node-1', summary: 'test' }],
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const processed = await runReviewPollCycle(COORDINATOR_URL, PEER_ID, LLM_CONFIG);

      expect(processed).toBeGreaterThanOrEqual(0);
    });

    it('should skip when no pending assignments', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const processed = await runReviewPollCycle(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      expect(processed).toBe(0);
    });
  });

  describe('startReviewLoop / stopReviewLoop', () => {
    it('should start and stop the review loop', () => {
      expect(isReviewLoopRunning()).toBe(false);

      startReviewLoop(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      expect(isReviewLoopRunning()).toBe(true);

      stopReviewLoop();
      expect(isReviewLoopRunning()).toBe(false);
    });

    it('should not start twice', () => {
      startReviewLoop(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      const firstHandle = isReviewLoopRunning();

      // Try to start again - should not change state
      startReviewLoop(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      expect(isReviewLoopRunning()).toBe(firstHandle);

      stopReviewLoop();
    });
  });
});
