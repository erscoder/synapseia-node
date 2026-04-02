/**
 * Peer Selector Service Tests
 * Sprint E — A2A Client
 */

import { PeerSelectorService } from '../client/peer-selector.service';
import { PeerRegistryService, type PeerA2AInfo } from '../client/peer-registry.service';
import { CircuitBreakerService } from '../client/circuit-breaker.service';

describe('PeerSelectorService', () => {
  // Fresh instances per test to avoid state pollution
  let registry: PeerRegistryService;
  let circuitBreaker: CircuitBreakerService;
  let selector: PeerSelectorService;
  let seq = 0;

  const makePeer = (overrides: Partial<PeerA2AInfo> = {}): PeerA2AInfo => ({
    peerId: `peer-${++seq}-${Date.now()}`,
    a2aUrl: `http://192.168.1.${20 + seq}:8080`,
    capabilities: ['llm'],
    tier: 2,
    domain: 'research',
    lastSeen: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    registry = new PeerRegistryService();
    circuitBreaker = new CircuitBreakerService();
    selector = new PeerSelectorService(registry, circuitBreaker);
    seq = 0; // reset for readability
  });

  describe('selectPeer', () => {
    it('should return null when no peers available', () => {
      expect(selector.selectPeer('llm')).toBeNull();
    });

    it('should return the only available peer', () => {
      registry.updatePeer(makePeer({ peerId: 'peer-llm-only', capabilities: ['llm'] }));
      const selected = selector.selectPeer('llm');
      expect(selected?.peerId).toBe('peer-llm-only');
    });

    it('should prefer same-domain peers', () => {
      registry.updatePeer(makePeer({ peerId: 'peer-research', domain: 'research', tier: 1 }));
      registry.updatePeer(makePeer({ peerId: 'peer-finance', domain: 'finance', tier: 3 }));

      const selected = selector.selectPeer('llm', 'research');
      expect(selected?.domain).toBe('research');
    });

    it('should prefer higher tier when domain same', () => {
      registry.updatePeer(makePeer({ peerId: 'peer-low', tier: 1 }));
      registry.updatePeer(makePeer({ peerId: 'peer-high', tier: 5 }));

      const selected = selector.selectPeer('llm', 'research');
      expect(selected?.peerId).toBe('peer-high');
    });

    it('should filter out peers with open circuits', () => {
      registry.updatePeer(makePeer({ peerId: 'peer-open', a2aUrl: 'http://open:8080' }));
      registry.updatePeer(makePeer({ peerId: 'peer-ok', a2aUrl: 'http://ok:8080' }));

      // Trip the circuit open for peer-open
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure('http://open:8080');
      }

      const selected = selector.selectPeer('llm');
      expect(selected?.peerId).toBe('peer-ok');
    });

    it('should return null when all peers have open circuits', () => {
      registry.updatePeer(makePeer({ peerId: 'peer-a', a2aUrl: 'http://a:8080' }));
      registry.updatePeer(makePeer({ peerId: 'peer-b', a2aUrl: 'http://b:8080' }));

      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure('http://a:8080');
        circuitBreaker.recordFailure('http://b:8080');
      }

      expect(selector.selectPeer('llm')).toBeNull();
    });

    it('should filter by capability', () => {
      registry.updatePeer(makePeer({ peerId: 'peer-llm', capabilities: ['llm'] }));
      registry.updatePeer(makePeer({ peerId: 'peer-embed', capabilities: ['embedding'] }));

      expect(selector.selectPeer('llm')?.peerId).toBe('peer-llm');
      expect(selector.selectPeer('embedding')?.peerId).toBe('peer-embed');
    });
  });

  describe('selectPeerWithCandidates', () => {
    it('should return both selected and all candidates', () => {
      registry.updatePeer(makePeer({ peerId: 'peer-cand-1', capabilities: ['llm'] }));
      registry.updatePeer(makePeer({ peerId: 'peer-cand-2', capabilities: ['llm'] }));

      const result = selector.selectPeerWithCandidates('llm');
      expect(result.candidates).toHaveLength(2);
      expect(result.selected).not.toBeNull();
    });
  });
});
