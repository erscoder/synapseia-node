/**
 * ModelDiscovery — Reports available models to the coordinator's inference service.
 * Sprint D: Discovery Feedback — nodes report which models they have.
 */

import axios from 'axios';
import logger from '../../utils/logger';
import { Injectable } from '@nestjs/common';
import { ModelCatalogHelper, MODEL_CATALOG } from '../model/model-catalog';
import type { Hardware } from '../hardware/hardware';
import type { Identity } from '../identity/identity';
import { buildAuthHeaders } from '../../utils/node-auth';

/** Model info as expected by coordinator's POST /inference/register */
export interface CoordinatorModelInfo {
  name: string;
  quantization: string;
  vram: number;
  maxContextLength: number;
  capabilities: string[];
}

export interface ModelRegistrationPayload {
  peerId: string;
  models: CoordinatorModelInfo[];
  /**
   * HTTP URL of this node's inference-server. Coordinator needs it to POST
   * `/inference/quote` (auction bid) and `/v1/chat/completions` (final
   * generation) once the user has paid. Derived from env vars at call time.
   */
  inferenceUrl?: string;
}

@Injectable()
export class ModelDiscovery {
  private lastRegisteredHash = '';

  /**
   * Discover locally available models and register them with the coordinator.
   * Called periodically after heartbeat to keep the model registry in sync.
   */
  async registerModels(
    coordinatorUrl: string,
    peerId: string,
    hardware: Hardware,
    identity?: Identity,
    ollamaUrl?: string,
  ): Promise<void> {
    try {
      const catalogHelper = new ModelCatalogHelper();
      const localModelNames = catalogHelper.getLocalModels(ollamaUrl);
      if (localModelNames.length === 0) {
        logger.log('[ModelDiscovery] No local models found, skipping registration');
        return;
      }

      const models = this.buildModelList(localModelNames, hardware);
      const hash = this.hashModels(models);

      // Only re-register if the model list has changed
      if (hash === this.lastRegisteredHash) {
        return;
      }

      const payload: ModelRegistrationPayload = {
        peerId,
        models,
        inferenceUrl: this.resolveInferenceUrl(),
      };

      // Build auth headers if identity is available
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (identity?.privateKey && identity?.publicKey) {
        try {
          const auth = await buildAuthHeaders({
            method: 'POST',
            path: '/inference/register',
            body: payload,
            privateKey: Buffer.from(identity.privateKey, 'hex'),
            publicKey: Buffer.from(identity.publicKey, 'hex'),
            peerId: identity.peerId,
          });
          Object.assign(headers, auth);
        } catch (signErr) {
          logger.warn('[ModelDiscovery] Failed to sign request:', (signErr as Error).message);
        }
      }

      await axios.post(`${coordinatorUrl}/inference/register`, payload, {
        timeout: 5000,
        headers,
      });

      this.lastRegisteredHash = hash;
      logger.log(`[ModelDiscovery] Registered ${models.length} model(s) with coordinator`);
    } catch (error) {
      logger.warn(`[ModelDiscovery] Failed to register models: ${(error as Error).message}`);
    }
  }

  /**
   * Build model info list matching coordinator's expected format.
   */
  buildModelList(localModelNames: string[], hardware: Hardware): CoordinatorModelInfo[] {
    return localModelNames.map(name => {
      // Try to find in catalog for richer metadata
      const catalogEntry = MODEL_CATALOG.find(
        m => m.name.toLowerCase() === name.split(':')[0].toLowerCase(),
      );

      const capabilities: string[] = [];
      if (catalogEntry?.category === 'embedding') {
        capabilities.push('embedding');
      } else {
        capabilities.push('inference');
        if (catalogEntry?.category === 'code') capabilities.push('code');
      }

      return {
        name: name.split(':')[0], // Strip version tag
        quantization: name.includes(':') ? name.split(':')[1] : 'default',
        vram: catalogEntry?.minVram ?? 0,
        maxContextLength: catalogEntry?.minVram && catalogEntry.minVram >= 4 ? 8192 : 4096,
        capabilities,
      };
    });
  }

  /**
   * Simple hash of model names for change detection.
   */
  private hashModels(models: CoordinatorModelInfo[]): string {
    return models.map(m => `${m.name}:${m.quantization}`).sort().join(',');
  }

  /**
   * The URL the coordinator should POST to for bids and generation. Priority:
   *   1. INFERENCE_PUBLIC_URL — explicit override (e.g. for dockerised nodes
   *      that need to announce their service name rather than localhost).
   *   2. http://<NODE_NAME>:<INFERENCE_PORT> — convention for docker compose.
   *   3. http://localhost:<INFERENCE_PORT> — dev fallback.
   * Omitted from the payload if nothing can be resolved — coordinator then
   * skips this node in auctions (won't crash it).
   */
  private resolveInferenceUrl(): string | undefined {
    const explicit = process.env.INFERENCE_PUBLIC_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    const port = process.env.INFERENCE_PORT || '8080';
    const nodeName = process.env.NODE_NAME;
    if (nodeName) return `http://${nodeName}:${port}`;
    return `http://localhost:${port}`;
  }
}
