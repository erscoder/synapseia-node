/**
 * Agent Card Service Tests
 * Sprint D — A2A Server
 */

import { AgentCardService, type A2ANodeConfig } from '../agent-card.service';

describe('AgentCardService', () => {
  let service: AgentCardService;

  beforeEach(() => {
    service = new AgentCardService();
  });

  describe('configure', () => {
    it('should store the configuration', () => {
      const config: A2ANodeConfig = {
        peerId: 'abcd1234abcd1234abcd1234abcd1234',
        hardwareClass: 3,
        domain: 'research',
        capabilities: ['llm', 'embedding'],
        a2aPort: 8080,
        version: '1.0.0',
      };

      service.configure(config);

      const card = service.getCard();
      expect(card.metadata.peerId).toBe(config.peerId);
      expect(card.metadata.hardwareClass).toBe(3);
    });
  });

  describe('getCard', () => {
    it('should throw if not configured', () => {
      expect(() => service.getCard()).toThrow('AgentCardService not configured');
    });

    it('should return a valid AgentCard', () => {
      const config: A2ANodeConfig = {
        peerId: 'abcd1234abcd1234abcd1234abcd1234',
        hardwareClass: 2,
        domain: 'training',
        capabilities: ['cpu_training', 'gpu_training'],
        a2aPort: 9090,
      };

      service.configure(config);
      const card = service.getCard();

      expect(card.name).toBe('Synapseia Node abcd1234');
      expect(card.description).toBe('Decentralized AI research agent node');
      expect(card.url).toBe('http://localhost:9090');
      expect(card.version).toBe('1.0.0');
      expect(card.capabilities.streaming).toBe(false);
      expect(card.capabilities.pushNotifications).toBe(false);
      expect(card.authentication.schemes).toContain('ed25519-signature');
      expect(card.metadata.hardwareClass).toBe(2);
      expect(card.metadata.domain).toBe('training');
      expect(card.metadata.peerId).toBe('abcd1234abcd1234abcd1234abcd1234');
      expect(typeof card.metadata.uptime).toBe('number');
    });

    it('should include health_check skill by default', () => {
      const config: A2ANodeConfig = {
        peerId: 'abcd1234abcd1234abcd1234abcd1234',
        hardwareClass: 1,
        domain: 'test',
        capabilities: [],
        a2aPort: 8080,
      };

      service.configure(config);
      const card = service.getCard();

      const healthSkill = card.skills.find(s => s.id === 'health_check');
      expect(healthSkill).toBeDefined();
      expect(healthSkill!.name).toBe('Health Check');
    });

    it('should map capability strings to skills', () => {
      const config: A2ANodeConfig = {
        peerId: 'abcd1234abcd1234abcd1234abcd1234',
        hardwareClass: 1,
        domain: 'test',
        capabilities: ['llm', 'embedding', 'cpu_training', 'gpu_training'],
        a2aPort: 8080,
      };

      service.configure(config);
      const card = service.getCard();

      const skillIds = card.skills.map(s => s.id);
      expect(skillIds).toContain('health_check');
      expect(skillIds).toContain('research/analysis');
      expect(skillIds).toContain('inference/embedding');
      expect(skillIds).toContain('training/cpu');
      expect(skillIds).toContain('training/gpu');
    });

    it('should use a2aHost when provided', () => {
      const config: A2ANodeConfig = {
        peerId: 'abcd1234abcd1234abcd1234abcd1234',
        hardwareClass: 1,
        domain: 'test',
        capabilities: [],
        a2aPort: 8080,
        a2aHost: '192.168.1.100',
      };

      service.configure(config);
      const card = service.getCard();

      expect(card.url).toBe('http://192.168.1.100:8080');
    });

    it('should derive node name from peerId', () => {
      const config: A2ANodeConfig = {
        peerId: 'abcd1234567890abcdef1234567890ab',
        hardwareClass: 1,
        domain: 'test',
        capabilities: [],
        a2aPort: 8080,
      };

      service.configure(config);
      const card = service.getCard();

      expect(card.name).toBe('Synapseia Node abcd1234');
    });
  });
});
