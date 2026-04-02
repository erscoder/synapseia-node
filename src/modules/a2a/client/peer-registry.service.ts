/**
 * Peer Registry Service
 * Sprint E — A2A Client for Synapseia Node
 *
 * Maintains a live map of peerId → PeerA2AInfo.
 * Updated from libp2p heartbeat data that carries A2A endpoint info.
 */

import { Injectable } from '@nestjs/common';

export interface PeerA2AInfo {
  peerId: string;
  a2aUrl: string;
  capabilities: string[];
  tier: number;
  domain: string;
  lastSeen: number;
}

@Injectable()
export class PeerRegistryService {
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly peers = new Map<string, PeerA2AInfo>();

  /**
   * Update peer info from a heartbeat or discovery event.
   * Uses the lastSeen from the passed info — callers should use Date.now()
   * for heartbeat-style updates to keep peers live.
   */
  updatePeer(info: PeerA2AInfo): void {
    this.peers.set(info.peerId, { ...info });
  }

  /**
   * Get all peers that have been seen within the TTL.
   * Stale entries are purged on each call.
   */
  getLivePeers(): PeerA2AInfo[] {
    const cutoff = Date.now() - this.TTL_MS;
    const live: PeerA2AInfo[] = [];
    for (const [peerId, info] of this.peers.entries()) {
      if (info.lastSeen >= cutoff) {
        live.push(info);
      } else {
        // Expired — remove
        this.peers.delete(peerId);
      }
    }
    return live;
  }

  /**
   * Get peers that have a specific capability, optionally filtered by domain.
   */
  getPeersWithCapability(capability: string, domain?: string): PeerA2AInfo[] {
    return this.getLivePeers().filter(p =>
      p.capabilities.includes(capability) &&
      (!domain || p.domain === domain),
    );
  }

  /**
   * Get info for a specific peer (may be stale).
   */
  getPeer(peerId: string): PeerA2AInfo | undefined {
    return this.peers.get(peerId);
  }

  /**
   * Remove a peer from the registry.
   */
  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  /**
   * Number of peers in the registry (including stale).
   */
  getSize(): number {
    return this.peers.size;
  }

  /**
   * Clear all peers.
   */
  clear(): void {
    this.peers.clear();
  }
}
