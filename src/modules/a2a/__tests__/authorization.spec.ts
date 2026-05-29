/**
 * A2A Authorization Service Tests (FINDING 1 — allowlist / default-deny)
 */

import { A2AAuthorizationService } from '../auth/a2a-authorization.service';
import { PeerRegistryService } from '../client/peer-registry.service';

describe('A2AAuthorizationService', () => {
  let registry: PeerRegistryService;
  let authz: A2AAuthorizationService;

  beforeEach(() => {
    registry = new PeerRegistryService();
    authz = new A2AAuthorizationService(registry);
  });

  it('derives a non-empty coordinator peerId from the hardcoded trust anchor', () => {
    const coordPeerId = authz.getCoordinatorPeerId();
    expect(coordPeerId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('authorizes the coordinator for any task type', () => {
    const coordPeerId = authz.getCoordinatorPeerId();
    expect(authz.isAuthorized(coordPeerId, 'delegate_research')).toBe(true);
    expect(authz.isAuthorized(coordPeerId.toUpperCase(), 'peer_review')).toBe(true);
  });

  it('allows health_check for any authenticated caller (publicly reachable)', () => {
    expect(authz.isAuthorized('unknownpeerunknownpeerunknownpe0', 'health_check')).toBe(true);
  });

  it('default-denies an unknown peer for privileged task types', () => {
    expect(authz.isAuthorized('unknownpeerunknownpeerunknownpe0', 'delegate_research')).toBe(false);
    expect(authz.isAuthorized('unknownpeerunknownpeerunknownpe0', 'peer_review')).toBe(false);
    expect(authz.isAuthorized('unknownpeerunknownpeerunknownpe0', 'embedding_request')).toBe(false);
    expect(authz.isAuthorized('unknownpeerunknownpeerunknownpe0', 'knowledge_query')).toBe(false);
  });

  it('authorizes a known live peer for privileged task types', () => {
    const peerId = 'knownpeerknownpeerknownpeerknown0';
    registry.updatePeer({
      peerId,
      a2aUrl: 'http://127.0.0.1:1',
      capabilities: ['research'],
      hardwareClass: 1,
      domain: 'test',
      lastSeen: Date.now(),
    });
    expect(authz.isAuthorized(peerId, 'delegate_research')).toBe(true);
  });

  it('rejects a stale (expired) peer for privileged task types', () => {
    const peerId = 'stalepeerstalepeerstalepeerstal0';
    registry.updatePeer({
      peerId,
      a2aUrl: 'http://127.0.0.1:1',
      capabilities: ['research'],
      hardwareClass: 1,
      domain: 'test',
      lastSeen: Date.now() - 10 * 60 * 1000, // older than TTL (5m)
    });
    expect(authz.isAuthorized(peerId, 'delegate_research')).toBe(false);
  });

  it('rejects an empty senderPeerId (fail-closed)', () => {
    expect(authz.isAuthorized('', 'health_check')).toBe(false);
  });
});
