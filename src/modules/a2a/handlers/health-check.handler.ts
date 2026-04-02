/**
 * Health Check Handler
 * Sprint D — A2A Server for Synapseia Node
 *
 * Returns node status, uptime, and capabilities.
 */

import { Injectable } from '@nestjs/common';
import { AgentCardService } from '../agent-card.service';

@Injectable()
export class HealthCheckHandler {
  private readonly startTime = Date.now();

  constructor(private readonly agentCardService: AgentCardService) {}

  handle(): unknown {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: '1.0.0',
      capabilities: this.agentCardService.getCard().skills.map(s => s.id),
    };
  }
}
