/**
 * ModelDiscovery — Reports available models to the coordinator's inference service.
 * Sprint D: Discovery Feedback — nodes report which models they have.
 */

import axios from 'axios';
import logger from '../../utils/logger';
import { Injectable } from '@nestjs/common';
import { getLocalModels, MODEL_CATALOG } from '../model/model-catalog';
import type { Hardware } from '../hardware/hardware';

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
  ): Promise<void> {
    try {
      const localModelNames = getLocalModels();
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

      const payload: ModelRegistrationPayload = { peerId, models };

      await axios.post(`${coordinatorUrl}/inference/register`, payload, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
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
}
