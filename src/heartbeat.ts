import axios from 'axios';
import type { Identity } from './identity.js';
import type { Hardware } from './hardware.js';
import type { P2PNode } from './p2p.js';

export interface HeartbeatPayload {
  peerId: string;
  walletAddress: string | null;
  tier: number;
  capabilities: string[];
  uptime: number;
}

export interface HeartbeatResponse {
  registered: boolean;
  peerId: string;
}

/**
 * Send heartbeat to coordinator with exponential backoff retry
 */
export async function sendHeartbeat(
  coordinatorUrl: string,
  identity: Identity,
  hardware: Hardware,
): Promise<HeartbeatResponse> {
  const startTime = Date.now();
  const capabilities = determineCapabilities(hardware);

  const payload: HeartbeatPayload = {
    peerId: identity.peerId,
    walletAddress: null, // TODO: connect wallet
    tier: hardware.tier,
    capabilities,
    uptime: startTime, // Process start time (simplified)
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
export function determineCapabilities(hardware: Hardware): string[] {
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
export function startPeriodicHeartbeat(
  coordinatorUrl: string,
  identity: Identity,
  hardware: Hardware,
  intervalMs: number = 30000,
  p2pNode?: P2PNode,
): () => void {
  const intervalId = setInterval(async () => {
    try {
      if (p2pNode && p2pNode.isRunning()) {
        const capabilities = determineCapabilities(hardware);
        await p2pNode.publishHeartbeat({
          peerId: p2pNode.getPeerId(),
          walletAddress: null,
          tier: hardware.tier,
          capabilities,
          uptime: Date.now(),
          timestamp: Math.floor(Date.now() / 1000),
        });
        console.log('[P2P] Heartbeat published via gossipsub');
      } else {
        await sendHeartbeat(coordinatorUrl, identity, hardware);
        console.log('Heartbeat sent via HTTP (fallback)');
      }
    } catch (error) {
      console.error('Heartbeat failed:', (error as Error).message);
    }
  }, intervalMs);

  return () => clearInterval(intervalId);
}
