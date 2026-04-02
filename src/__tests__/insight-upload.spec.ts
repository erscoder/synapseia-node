import { jest } from '@jest/globals';
import { _test } from '../modules/agent/work-order-agent';

// Mock fetch globally
global.fetch = jest.fn() as any;

describe('Insight Upload to Network', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('uploadInsightToNetwork', () => {
    const baseParams = {
      coordinatorUrl: 'http://localhost:3001',
      nodeId: 'node_001',
      topic: 'machine-learning',
      hypothesis: 'Deep learning models can achieve superhuman performance on protein folding tasks',
      keyInsights: [
        'AlphaFold2 achieves sub-angstrom RMSD on CASP14',
        'Evoformer architecture combines sequence and structure attention',
        'Multi-sequence alignment provides evolutionary context crucial for accuracy',
      ],
      metricValue: 0.85,
    };

    it('should upload insight when metricValue > 0.7', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'insight_123' }),
      });

      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/insights',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodeId: 'node_001',
            topic: 'machine-learning',
            hypothesis: baseParams.hypothesis,
            keyInsights: baseParams.keyInsights,
            metricValue: 0.85,
          }),
        })
      );
    });

    it('should skip upload when metricValue <= 0.7', async () => {
      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        0.7 // exactly at threshold - should skip
      );

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should skip upload when metricValue is 0.5', async () => {
      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        0.5
      );

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should skip upload when metricValue is 0.0', async () => {
      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        0.0
      );

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should upload with roundId and submissionId when provided', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'insight_456' }),
      });

      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue,
        'round_42',
        'submission_99'
      );

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/insights',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            nodeId: 'node_001',
            topic: 'machine-learning',
            hypothesis: baseParams.hypothesis,
            keyInsights: baseParams.keyInsights,
            metricValue: 0.85,
            roundId: 'round_42',
            submissionId: 'submission_99',
          }),
        })
      );
    });

    it('should gracefully handle network errors', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('ECONNRESET'));

      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      expect(result).toBe(false);
    });

    it('should gracefully handle non-200 responses', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      expect(result).toBe(false);
    });

    it('should gracefully handle non-200 with non-json error response', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      expect(result).toBe(false);
    });

    it('should send correct payload format', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await _test.uploadInsightToNetwork(
        'http://localhost:3001',
        'node_test',
        'quantum-computing',
        'Quantum supremacy achieved on random circuit sampling',
        ['Insight 1', 'Insight 2', 'Insight 3'],
        0.95
      );

      const fetchCall = (global.fetch as any).mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      // Verify payload structure
      expect(requestBody).toHaveProperty('nodeId', 'node_test');
      expect(requestBody).toHaveProperty('topic', 'quantum-computing');
      expect(requestBody).toHaveProperty('hypothesis');
      expect(requestBody).toHaveProperty('keyInsights');
      expect(requestBody).toHaveProperty('metricValue');
      expect(Array.isArray(requestBody.keyInsights)).toBe(true);
      expect(requestBody.keyInsights).toHaveLength(3);
    });

    it('should include Content-Type header', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/insights',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should use correct HTTP method', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/insights',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should upload successfully at exactly 0.71 threshold', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'insight_test' }),
      });

      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        0.71
      );

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should not upload at exactly 0.70 threshold', async () => {
      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        0.70
      );

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should not upload for metricValue just below 0.7 (0.699)', async () => {
      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        0.699
      );

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should handle empty keyInsights array', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'insight_empty' }),
      });

      const result = await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        [],
        0.9
      );

      expect(result).toBe(true);
      const fetchCall = (global.fetch as any).mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);
      expect(requestBody.keyInsights).toEqual([]);
    });

    it('should handle special characters in hypothesis', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        'Hypothesis with "quotes" and <special> chars & symbols: @#$%',
        baseParams.keyInsights,
        0.85
      );

      // Should not throw, just verify fetch was called
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle unicode in hypothesis', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await _test.uploadInsightToNetwork(
        baseParams.coordinatorUrl,
        baseParams.nodeId,
        baseParams.topic,
        'Hypothesis with unicode: 日本語 中文 한국어 العربية 🇪🇸',
        baseParams.keyInsights,
        0.85
      );

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle coordinatorUrl without trailing slash', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await _test.uploadInsightToNetwork(
        'http://localhost:3001', // no trailing slash
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/insights',
        expect.any(Object)
      );
    });

    it('should handle coordinatorUrl with trailing slash', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await _test.uploadInsightToNetwork(
        'http://localhost:3001/', // with trailing slash
        baseParams.nodeId,
        baseParams.topic,
        baseParams.hypothesis,
        baseParams.keyInsights,
        baseParams.metricValue
      );

      // URL should be properly formed without double slashes
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/insights',
        expect.any(Object)
      );
    });
  });
});
