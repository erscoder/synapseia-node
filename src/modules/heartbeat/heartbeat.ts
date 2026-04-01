import axios from 'axios';
import logger from '../../utils/logger.js';
import { Injectable } from '@nestjs/common';
import type { Identity } from '../identity/identity.js';
import type { Hardware } from '../hardware/hardware.js';
import type { P2PNode } from '../p2p/p2p.js';
import { ModelDiscovery } from '../discovery/model-discovery.js';

export interface HeartbeatPayload {
  peerId: string;
  publicKey: string;  // Full Ed25519 public key (64 hex chars = 32 bytes)
  walletAddress: string | null;
  tier: number;
  capabilities: string[];
  uptime: number;
  name?: string;
  lat?: number;
  lng?: number;
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
    lat?: number,
    lng?: number,
    walletAddress?: string | null,
  ): Promise<HeartbeatResponse> {
    const startTime = Date.now();
    const capabilities = this.determineCapabilities(hardware);

    const payload: HeartbeatPayload = {
      peerId: identity.peerId,
      name: identity.name,
      publicKey: identity.publicKey,  // Full Ed25519 public key for node signature verification
      walletAddress: walletAddress ?? null, // Solana wallet address for reward payouts
      tier: hardware.tier,
      capabilities,
      uptime: Math.floor((Date.now() - startTime) / 1000), // Seconds since process start
      lat,
      lng,
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
        logger.warn(`Heartbeat attempt ${attempt + 1} failed: ${(error as Error).message}`);

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
   * Determine capabilities based on hardware.
   *
   * Capability taxonomy:
   *  - cpu_training  → hyperparam search (train_micro.py / PyTorch CPU). Any node.
   *  - gpu_training  → DiLoCo federated fine-tuning (LoRA, requires VRAM). GPU nodes only.
   *  - cpu_inference → tokenize / embed / classify. Always enabled (no LLM needed).
   *  - inference     → full LLM inference (requires Ollama or cloud LLM).
   *  - llm           → alias for inference, kept for backwards compat.
   *  - embedding     → Ollama embedding models (requires Ollama + ≥8 GB RAM).
   */
  determineCapabilities(hardware: Hardware): string[] {
    const capabilities: string[] = [];

    // cpu_training: any node can run micro-transformer hyperparam search (PyTorch CPU)
    capabilities.push('cpu_training');

    // cpu_inference: tokenize/classify/embedding tasks that run on CPU without a full LLM.
    // Always enabled — these tasks have no GPU/Ollama dependency.
    capabilities.push('cpu_inference');

    // Add LLM-based inference capabilities if Ollama is running OR cloud LLM is configured
    if (hardware.hasOllama || hardware.hasCloudLlm) {
      capabilities.push('inference');
      capabilities.push('llm');
    }

    // Add embedding capability if Ollama can run embeddings
    if (hardware.hasOllama && hardware.ramGb >= 8) {
      capabilities.push('embedding');
    }

    // gpu_training: DiLoCo LoRA fine-tuning — requires dedicated GPU VRAM
    if (hardware.gpuVramGb > 0) {
      capabilities.push('gpu_training');
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
    lat?: number,
    lng?: number,
    walletAddress?: string | null,
  ): () => void {
    const intervalStartTime = Date.now();
    const modelDiscovery = new ModelDiscovery();
    const intervalId = setInterval(async () => {
      try {
        const uptimeSeconds = Math.floor((Date.now() - intervalStartTime) / 1000);
        // Always send HTTP heartbeat to register with coordinator
        try {
          await this.sendHeartbeat(coordinatorUrl, identity, hardware, lat, lng, walletAddress);
        } catch (httpErr) {
          logger.error('HTTP heartbeat failed:', (httpErr as Error).message);
        }
        // Sprint D: Discovery feedback — register available models with coordinator
        try {
          await modelDiscovery.registerModels(coordinatorUrl, identity.peerId, hardware);
        } catch (discErr) {
          logger.warn('Model discovery registration failed:', (discErr as Error).message);
        }
        // Also publish via P2P if available
        if (p2pNode && p2pNode.isRunning()) {
          const capabilities = this.determineCapabilities(hardware);
          await p2pNode.publishHeartbeat({
            peerId: p2pNode.getPeerId(),
            name: identity.name,
            publicKey: identity.publicKey,
            walletAddress: walletAddress ?? null,
            tier: hardware.tier,
            capabilities,
            uptime: uptimeSeconds,
            timestamp: Math.floor(Date.now() / 1000),
          });
          logger.log('[P2P+HTTP] Heartbeat sent via both channels');
        } else {
          logger.log('Heartbeat sent via HTTP only');
        }
      } catch (error) {
        logger.error('Heartbeat failed:', (error as Error).message);
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
