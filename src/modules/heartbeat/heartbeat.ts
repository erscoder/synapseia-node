import axios from 'axios';
import { Injectable } from '@nestjs/common';
import type { Identity } from '../identity/identity.js';
import type { Hardware } from '../hardware/hardware.js';
import type { P2PNode } from '../p2p/p2p.js';

export interface HeartbeatPayload {
  peerId: string;
  publicKey: string;  // Full Ed25519 public key (64 hex chars = 32 bytes)
  walletAddress: string | null;
  tier: number;
  capabilities: string[];
  uptime: number;
}

export interface HeartbeatResponse {
  registered: boolean;
  peerId: string;
}

@Injectable()
export class HeartbeatHelper {
  /**
   * Send heartbeat to coordinator with exponential backoff retry
   */
  async sendHeartbeat(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
  ): Promise<HeartbeatResponse> {
    const startTime = Date.now();
    const capabilities = this.determineCapabilities(hardware);

    const payload: HeartbeatPayload = {
      peerId: identity.peerId,
      publicKey: identity.publicKey,  // Full Ed25519 public key for signature verification
      walletAddress: null, // TODO: connect wallet
      tier: hardware.tier,
      capabilities,
      uptime: Math.floor((Date.now() - startTime) / 1000), // Seconds since process start
    };

    let lastError: Error | null = null;

    // Exponential backoff: 1s, 2s, 4s
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const client = axios.create({
          baseURL: coordinatorUrl,
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
          },
        });

        const response = await client.post<HeartbeatResponse>('/peer/heartbeat', payload);
        return response.data;
      } catch (error) {
        lastError = error as Error;
        console.warn(`Heartbeat attempt ${attempt + 1} failed: ${(error as Error).message}`);

        if (attempt < 2) {
          // Wait before retry: 1s, 2s
          const delayMs = 1000 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new Error(`Failed to send heartbeat after 3 attempts: ${lastError?.message}`);
  }

  /**
   * Determine capabilities based on hardware
   */
  determineCapabilities(hardware: Hardware): string[] {
    const capabilities: string[] = [];

    // CPU is always available
    capabilities.push('cpu');

    // Add inference capability if Ollama is running
    if (hardware.hasOllama) {
      capabilities.push('inference');
    }

    // Add embedding capability if Ollama can run embeddings
    if (hardware.hasOllama && hardware.ramGb >= 8) {
      capabilities.push('embedding');
    }

    return capabilities;
  }

  /**
   * Start periodic heartbeat (every 30 seconds)
   * If p2pNode is provided, heartbeat is published via GossipSub.
   * Falls back to HTTP if P2P is not available.
   */
  startPeriodicHeartbeat(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    intervalMs: number = 30000,
    p2pNode?: P2PNode,
  ): () => void {
    const intervalStartTime = Date.now();
    const intervalId = setInterval(async () => {
      try {
        const uptimeSeconds = Math.floor((Date.now() - intervalStartTime) / 1000);
        if (p2pNode && p2pNode.isRunning()) {
          const capabilities = this.determineCapabilities(hardware);
          await p2pNode.publishHeartbeat({
            peerId: p2pNode.getPeerId(),
            publicKey: identity.publicKey,  // Full Ed25519 public key for signature verification
            walletAddress: null,
            tier: hardware.tier,
            capabilities,
            uptime: uptimeSeconds,
            timestamp: Math.floor(Date.now() / 1000),
          });
          console.log('[P2P] Heartbeat published via gossipsub');
        } else {
          await this.sendHeartbeat(coordinatorUrl, identity, hardware);
          console.log('Heartbeat sent via HTTP (fallback)');
        }
      } catch (error) {
        console.error('Heartbeat failed:', (error as Error).message);
      }
    }, intervalMs);

    return () => clearInterval(intervalId);
  }
}

// Backward-compatible standalone exports
export const sendHeartbeat = (
  coordinatorUrl: string,
  identity: Identity,
  hardware: Hardware,
): Promise<HeartbeatResponse> =>
  new HeartbeatHelper().sendHeartbeat(coordinatorUrl, identity, hardware);

export const determineCapabilities = (hardware: Hardware): string[] =>
  new HeartbeatHelper().determineCapabilities(hardware);

export const startPeriodicHeartbeat = (
  coordinatorUrl: string,
  identity: Identity,
  hardware: Hardware,
  intervalMs?: number,
  p2pNode?: P2PNode,
): () => void =>
  new HeartbeatHelper().startPeriodicHeartbeat(coordinatorUrl, identity, hardware, intervalMs ?? 30000, p2pNode);
