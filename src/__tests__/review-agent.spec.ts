import { jest } from '@jest/globals';
import {
  ReviewAgentHelper,
  type LLMReviewConfig,
  type EvaluationAssignment,
  type Submission,
  type ReviewScores,
} from '../modules/agent/review-agent';
import type { LLMModel } from '../modules/llm/llm-provider';

const mockFetch: any = jest.fn();
(global as any).fetch = mockFetch;

jest.unstable_mockModule('../modules/llm/llm-provider.js', () => ({
  LlmProviderHelper: jest.fn().mockImplementation(() => ({
    generateLLM: jest.fn(
      async (_model: LLMModel, _prompt: string, _config?: any): Promise<string> => {
        return JSON.stringify({
          accuracy: 8,
          novelty: 7,
          methodology: 9,
          conclusions: 8,
          commentary: 'Solid research with strong methodology.',
        });
      }
    ),
  })),
}));

describe('ReviewAgentHelper', () => {
  let helper: ReviewAgentHelper;
  const COORDINATOR_URL = 'http://localhost:3701';
  const PEER_ID = 'test-node-123';
  const LLM_CONFIG: LLMReviewConfig = {
    llmModel: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
    llmConfig: { baseUrl: 'http://localhost:11434' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    helper = new ReviewAgentHelper();
    helper.stopReviewLoop();
  });

  afterEach(() => {
    helper.stopReviewLoop();
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

      const result = await helper.fetchEvaluationAssignments(COORDINATOR_URL, PEER_ID);

      expect(global.fetch).toHaveBeenCalledWith(
        `${COORDINATOR_URL}/evaluations/assignments?nodeId=${PEER_ID}`
      );
      expect(result).toEqual(mockAssignments);
    });

    it('should return empty array on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await helper.fetchEvaluationAssignments(COORDINATOR_URL, PEER_ID);
      expect(result).toEqual([]);
    });

    it('should return empty array on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const result = await helper.fetchEvaluationAssignments(COORDINATOR_URL, PEER_ID);
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

      const result = await helper.fetchSubmissionsForRound(COORDINATOR_URL, 'r1');

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

      const prompt = helper.buildReviewPrompt(submission);

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

      const prompt = helper.buildReviewPrompt(submission);

      expect(prompt).toContain('Direct Title');
      expect(prompt).toContain('Direct summary');
      expect(prompt).toContain('direct insight');
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

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await helper.postEvaluation(COORDINATOR_URL, PEER_ID, assignment, scores);

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

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await helper.postEvaluation(COORDINATOR_URL, PEER_ID, assignment, scores);
      expect(result).toBe(false);
    });
  });

  describe('runReviewPollCycle', () => {
    it('should process pending assignments', async () => {
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

      const processed = await helper.runReviewPollCycle(COORDINATOR_URL, PEER_ID, LLM_CONFIG);

      expect(processed).toBeGreaterThanOrEqual(0);
    });

    it('should skip when no pending assignments', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

      const processed = await helper.runReviewPollCycle(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      expect(processed).toBe(0);
    });
  });

  describe('startReviewLoop / stopReviewLoop / isReviewLoopRunning', () => {
    it('should start and stop the review loop', () => {
      expect(helper.isReviewLoopRunning()).toBe(false);

      helper.startReviewLoop(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      expect(helper.isReviewLoopRunning()).toBe(true);

      helper.stopReviewLoop();
      expect(helper.isReviewLoopRunning()).toBe(false);
    });

    it('should not start twice', () => {
      helper.startReviewLoop(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      const firstHandle = helper.isReviewLoopRunning();

      helper.startReviewLoop(COORDINATOR_URL, PEER_ID, LLM_CONFIG);
      expect(helper.isReviewLoopRunning()).toBe(firstHandle);

      helper.stopReviewLoop();
    });
  });
});
