/**
 * Agent Card Service
 * Sprint D — A2A Server for Synapseia Node
 *
 * Generates and serves the AgentCard that advertises node capabilities
 * via GET /.well-known/agent.json
 */

import { Injectable } from '@nestjs/common';
import type { AgentCard, A2ASkill, A2ANodeConfig } from './types';
export type { A2ANodeConfig } from './types';

@Injectable()
export class AgentCardService {
  private startTime = Date.now();
  private config: A2ANodeConfig | null = null;

  configure(config: A2ANodeConfig): void {
    this.config = config;
  }

  getCard(): AgentCard {
    if (!this.config) throw new Error('AgentCardService not configured');

    const host = this.config.a2aHost ?? 'localhost';
    const url = `http://${host}:${this.config.a2aPort}`;

    return {
      name: `Synapseia Node ${this.config.peerId.slice(0, 8)}`,
      description: 'Decentralized AI research agent node',
      url,
      version: this.config.version ?? '1.0.0',
      capabilities: { streaming: false, pushNotifications: false },
      skills: this.buildSkills(this.config.capabilities),
      authentication: { schemes: ['ed25519-signature'] },
      metadata: {
        hardwareClass: this.config.hardwareClass,
        stakingTier: this.config.stakingTier,
        domain: this.config.domain,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        peerId: this.config.peerId,
      },
    };
  }

  private buildSkills(capabilities: string[]): A2ASkill[] {
    const skillMap: Record<string, A2ASkill> = {
      llm: {
        id: 'research/analysis',
        name: 'Research Analysis',
        description: 'Analyze research papers with LLM',
      },
      cpu: {
        id: 'training/cpu',
        name: 'CPU Training',
        description: 'Train ML models on CPU',
      },
      inference: {
        id: 'inference/llm',
        name: 'LLM Inference',
        description: 'Full LLM inference via Ollama or cloud',
      },
      embedding: {
        id: 'inference/embedding',
        name: 'Text Embedding',
        description: 'Generate semantic embeddings for text',
      },
      review: {
        id: 'peer_review',
        name: 'Peer Review',
        description: 'Score and evaluate research submissions',
      },
      cpu_training: {
        id: 'training/cpu',
        name: 'CPU Training',
        description: 'Train ML models on CPU',
      },
      gpu_training: {
        id: 'training/gpu',
        name: 'GPU Training',
        description: 'DiLoCo federated fine-tuning with GPU',
      },
    };

    const skills: A2ASkill[] = [
      {
        id: 'health_check',
        name: 'Health Check',
        description: 'Return node status and capabilities',
      },
    ];

    for (const cap of capabilities) {
      if (skillMap[cap]) {
        skills.push(skillMap[cap]);
      }
    }

    return skills;
  }
}
