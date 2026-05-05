/**
 * Peer Selector Service
 * Sprint E — A2A Client for Synapseia Node
 *
 * Selects the best peer for a given capability/task.
 * Prefers: same domain > higher hardwareClass > circuit closed.
 * Adds jitter to avoid thundering-herd on a single high-hardwareClass peer.
 */

import { Injectable } from '@nestjs/common';
import { PeerRegistryService, type PeerA2AInfo } from './peer-registry.service';
import { CircuitBreakerService } from './circuit-breaker.service';

@Injectable()
export class PeerSelectorService {
  constructor(
    private readonly registry: PeerRegistryService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /**
   * Select the best peer for a given capability.
   *
   * Strategy:
   * 1. Filter out peers with open circuits
   * 2. Sort: same-domain peers first, then hardwareClass descending
   * 3. Pick randomly from the top hardwareClass band (±1) to spread load
   *
   * Returns null if no suitable peer is available.
   */
  selectPeer(capability: string, preferredDomain?: string): PeerA2AInfo | null {
    const candidates = this.registry.getPeersWithCapability(capability)
      .filter(p => !this.circuitBreaker.isOpen(p.a2aUrl));

    if (candidates.length === 0) return null;

    // Sort: domain match first, then hardwareClass desc
    candidates.sort((a, b) => {
      const aDomainMatch = preferredDomain && a.domain === preferredDomain ? 1 : 0;
      const bDomainMatch = preferredDomain && b.domain === preferredDomain ? 1 : 0;
      if (aDomainMatch !== bDomainMatch) return bDomainMatch - aDomainMatch;
      return b.hardwareClass - a.hardwareClass;
    });

    // If domain preference given, prioritise domain-matching peers absolutely
    if (preferredDomain) {
      const domainMatches = candidates.filter(p => p.domain === preferredDomain);
      if (domainMatches.length > 0) {
        // Within domain matches, weighted random among top hardwareClass band
        const topDomainHardwareClass = domainMatches[0].hardwareClass;
        const top = domainMatches.filter(p => p.hardwareClass >= topDomainHardwareClass - 1);
        return top[Math.floor(Math.random() * top.length)];
      }
    }

    // No domain preference or no domain matches — pick by hardwareClass with jitter
    const topHardwareClass = candidates[0].hardwareClass;
    const topCandidates = candidates.filter(p => p.hardwareClass >= topHardwareClass - 1);
    return topCandidates[Math.floor(Math.random() * topCandidates.length)];
  }

  /**
   * Select the best peer for a given capability, returning all candidates too.
   */
  selectPeerWithCandidates(
    capability: string,
    preferredDomain?: string,
  ): { selected: PeerA2AInfo | null; candidates: PeerA2AInfo[] } {
    const candidates = this.registry.getPeersWithCapability(capability)
      .filter(p => !this.circuitBreaker.isOpen(p.a2aUrl));
    return {
      selected: this.selectPeer(capability, preferredDomain),
      candidates,
    };
  }
}
