/**
 * Peer Registry Service Tests
 * Sprint E — A2A Client
 */

import { PeerRegistryService, type PeerA2AInfo } from '../client/peer-registry.service';

describe('PeerRegistryService', () => {
  // Use unique peer IDs per test to avoid cross-test pollution
  let registry: PeerRegistryService;
  let seq = 0;

  const makePeer = (overrides: Partial<PeerA2AInfo> = {}): PeerA2AInfo => ({
    peerId: `peer-${++seq}`,
    a2aUrl: `http://192.168.1.${10 + seq}:8080`,
    capabilities: ['llm', 'embedding'],
    tier: 2,
    domain: 'research',
    lastSeen: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    registry = new PeerRegistryService();
  });

  describe('updatePeer', () => {
    it('should add a new peer', () => {
      registry.updatePeer(makePeer());
      expect(registry.getSize()).toBe(1);
    });

    it('should update existing peer', () => {
      const p = makePeer({ tier: 2 });
      registry.updatePeer(p);
      registry.updatePeer({ ...p, tier: 3 });
      expect(registry.getPeer(p.peerId)?.tier).toBe(3);
    });
  });

  describe('getLivePeers', () => {
    it('should return empty initially', () => {
      expect(registry.getLivePeers()).toEqual([]);
    });

    it('should return fresh peers', () => {
      registry.updatePeer(makePeer());
      expect(registry.getLivePeers()).toHaveLength(1);
    });

    it('should remove peers older than TTL (5 minutes)', () => {
      // TTL is 5 minutes — set lastSeen to 6 minutes ago
      registry.updatePeer(makePeer({
        peerId: `stale-peer-${Date.now()}`,
        lastSeen: Date.now() - 6 * 60 * 1000,
      }));
      const live = registry.getLivePeers();
      expect(live).toHaveLength(0);
    });

    it('should include peers exactly at TTL boundary as fresh', () => {
      // Just within TTL — should be included
      registry.updatePeer(makePeer({
        peerId: `boundary-peer-${Date.now()}`,
        lastSeen: Date.now() - 4 * 60 * 1000, // 4 min ago (< 5 min TTL)
      }));
      expect(registry.getLivePeers()).toHaveLength(1);
    });
  });

  describe('getPeersWithCapability', () => {
    beforeEach(() => {
      registry.updatePeer(makePeer({ peerId: 'peer-llm', capabilities: ['llm', 'embedding'] }));
      registry.updatePeer(makePeer({ peerId: 'peer-embed', capabilities: ['embedding'] }));
      registry.updatePeer(makePeer({ peerId: 'peer-nlp', capabilities: ['nlp'] }));
    });

    it('should filter by capability', () => {
      const llmPeers = registry.getPeersWithCapability('llm');
      expect(llmPeers).toHaveLength(1);
      expect(llmPeers[0].peerId).toBe('peer-llm');
    });

    it('should filter by capability and domain', () => {
      registry.updatePeer(makePeer({
        peerId: 'peer-domain-a',
        capabilities: ['llm'],
        domain: 'finance',
      }));
      registry.updatePeer(makePeer({
        peerId: 'peer-domain-b',
        capabilities: ['llm'],
        domain: 'research',
      }));

      const financePeers = registry.getPeersWithCapability('llm', 'finance');
      expect(financePeers).toHaveLength(1);
      expect(financePeers[0].peerId).toBe('peer-domain-a');
    });

    it('should return empty when no match', () => {
      const peers = registry.getPeersWithCapability('nonexistent');
      expect(peers).toHaveLength(0);
    });
  });

  describe('getPeer', () => {
    it('should return undefined for unknown peer', () => {
      expect(registry.getPeer('unknown')).toBeUndefined();
    });

    it('should return peer info', () => {
      const p = makePeer({ tier: 5 });
      registry.updatePeer(p);
      expect(registry.getPeer(p.peerId)?.tier).toBe(5);
    });
  });

  describe('removePeer', () => {
    it('should remove a peer', () => {
      const p = makePeer();
      registry.updatePeer(p);
      expect(registry.getSize()).toBe(1);

      registry.removePeer(p.peerId);
      expect(registry.getSize()).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all peers', () => {
      registry.updatePeer(makePeer());
      registry.updatePeer(makePeer());
      expect(registry.getSize()).toBe(2);

      registry.clear();
      expect(registry.getSize()).toBe(0);
    });
  });
});
