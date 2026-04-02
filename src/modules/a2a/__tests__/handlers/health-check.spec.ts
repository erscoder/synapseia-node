/**
 * Health Check Handler Tests
 * Sprint D — A2A Server
 */

import { HealthCheckHandler } from '../../handlers/health-check.handler';
import { AgentCardService } from '../../agent-card.service';

describe('HealthCheckHandler', () => {
  let handler: HealthCheckHandler;

  beforeEach(() => {
    const cardService = new AgentCardService();
    cardService.configure({
      peerId: 'test-peer-id-12345678',
      tier: 1,
      domain: 'test',
      capabilities: ['llm', 'embedding'],
      a2aPort: 8080,
    });
    handler = new HealthCheckHandler(cardService);
  });

  describe('handle', () => {
    it('should return status ok', () => {
      const result = handler.handle() as Record<string, unknown>;

      expect(result['status']).toBe('ok');
    });

    it('should return a positive uptime', () => {
      const result = handler.handle() as Record<string, unknown>;

      expect(typeof result['uptime']).toBe('number');
      expect(result['uptime']).toBeGreaterThanOrEqual(0);
    });

    it('should return version', () => {
      const result = handler.handle() as Record<string, unknown>;

      expect(result['version']).toBe('1.0.0');
    });

    it('should return capabilities from AgentCard', () => {
      const result = handler.handle() as Record<string, unknown>;

      expect(Array.isArray(result['capabilities'])).toBe(true);
    });
  });
});
