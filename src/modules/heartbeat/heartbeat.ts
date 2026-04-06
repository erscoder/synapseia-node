import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom, map } from 'rxjs';
import logger from '../../utils/logger';
import type { Identity } from '../identity/identity';
import type { Hardware } from '../hardware/hardware';
import type { P2PNode } from '../p2p/p2p';
import { isPyTorchAvailable } from '../model/trainer';
import { ModelDiscovery } from '../discovery/model-discovery';
import { IpifyService } from '../shared/infrastructure/ipify.service';
import { buildAuthHeaders } from '../../utils/node-auth';

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
  publicIp?: string; // Self-reported public IP for geo-lookup
}

export interface HeartbeatResponse {
  registered: boolean;
  peerId: string;
}

@Injectable()
export class HeartbeatHelper {
  constructor(
    private readonly ipifyService: IpifyService,
    private readonly httpService?: HttpService,
  ) {}
  /**
   * Send heartbeat to coordinator with exponential backoff retry
   */
  /**
   * Send signed heartbeat to coordinator.
   * If keypair is available, signs the request with Ed25519.
   */
  async sendHeartbeat(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    lat?: number,
    lng?: number,
    walletAddress?: string | null,
  ): Promise<HeartbeatResponse> {
    return this._sendHeartbeat(coordinatorUrl, identity, hardware, lat, lng, walletAddress);
  }

  /**
   * Internal: supports optional pre-built auth headers for testing.
   */
  private async _sendHeartbeat(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    lat?: number,
    lng?: number,
    walletAddress?: string | null,
  ): Promise<HeartbeatResponse> {
    const startTime = Date.now();
    const capabilities = await this.determineCapabilitiesAsync(hardware);

    // Resolve public IP for geo-lookup (cached 30 min)
    const publicIp = await this.ipifyService.resolvePublicIp();

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
      publicIp: publicIp ?? undefined,
    };

    let lastError: Error | null = null;

    // Build auth headers if keypair is available
    let authHeaders: Record<string, string> = {};
    if (identity.privateKey && identity.publicKey) {
      try {
        authHeaders = await buildAuthHeaders({
          method: 'POST',
          path: '/peer/heartbeat',
          body: payload,
          privateKey: Buffer.from(identity.privateKey, 'hex'),
          publicKey: Buffer.from(identity.publicKey, 'hex'),
          peerId: identity.peerId,
        });
      } catch (signErr) {
        logger.warn('[Heartbeat] Failed to sign heartbeat:', (signErr as Error).message);
      }
    }

    // Exponential backoff: 1s, 2s, 4s
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let response: HeartbeatResponse;
        if (this.httpService) {
          response = await lastValueFrom(
            this.httpService.post<HeartbeatResponse>('/peer/heartbeat', payload, {
              baseURL: coordinatorUrl,
              timeout: 5000,
              headers: { 'Content-Type': 'application/json', ...authHeaders },
            }).pipe(map(res => res.data)),
          );
        } else {
          // Fallback: use raw axios for standalone CLI usage
          const { default: axios } = await import('axios');
          const client = axios.create({ baseURL: coordinatorUrl, timeout: 5000, headers: { 'Content-Type': 'application/json', ...authHeaders } });
          const axiosRes = await client.post<HeartbeatResponse>('/peer/heartbeat', payload);
          response = axiosRes.data;
        }
        return response;
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

    // cpu_training: micro-transformer hyperparam search (PyTorch CPU, requires python3 + torch)
    // NOTE: determineCapabilities() is sync but isPyTorchAvailable() is async.
    // The heartbeat loop calls determineCapabilitiesAsync() instead for accuracy.
    // This sync version assumes PyTorch IS available (conservative default).
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
   * Async version of determineCapabilities — checks PyTorch availability
   * before emitting cpu_training. Used by the heartbeat loop.
   */
  async determineCapabilitiesAsync(hardware: Hardware): Promise<string[]> {
    const caps = this.determineCapabilities(hardware);
    // Verify PyTorch is actually available before claiming cpu_training
    const hasTorch = await isPyTorchAvailable();
    if (!hasTorch) {
      const idx = caps.indexOf('cpu_training');
      if (idx !== -1) caps.splice(idx, 1);
      logger.warn('[Heartbeat] PyTorch not found — removing cpu_training capability. Install with: pip3 install torch');
    }
    return caps;
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
          await modelDiscovery.registerModels(coordinatorUrl, identity.peerId, hardware, identity);
        } catch (discErr) {
          logger.warn('Model discovery registration failed:', (discErr as Error).message);
        }
        // Also publish via P2P if available
        if (p2pNode && p2pNode.isRunning()) {
          const capabilities = await this.determineCapabilitiesAsync(hardware);
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


