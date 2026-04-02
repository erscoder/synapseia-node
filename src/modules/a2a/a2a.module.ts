/**
 * A2A Module
 * Sprint D/E — A2A Server + Client for Synapseia Node
 *
 * Provides A2A server functionality for inter-node task delegation.
 * Each Synapseia node acts as an A2A agent that can receive and execute
 * tasks from other nodes in the network.
 *
 * Sprint E adds client-side services for sending tasks to remote peers.
 */

import { Module } from '@nestjs/common';
import { AgentCardService } from './agent-card.service';
import { A2AAuthService } from './auth/a2a-auth.service';
import { A2AServer } from './a2a-server.service';
import { TaskRouter } from './task-router';
import { PeerReviewHandler } from './handlers/peer-review.handler';
import { EmbeddingHandler } from './handlers/embedding.handler';
import { HealthCheckHandler } from './handlers/health-check.handler';
import { DelegateResearchHandler } from './handlers/delegate-research.handler';
import { ReviewAgentHelper } from '../agent/review-agent';
import { A2AClientModule } from './client/client.module';

@Module({
  imports: [A2AClientModule],
  providers: [
    // Core services
    AgentCardService,
    A2AAuthService,
    A2AServer,
    TaskRouter,
    // Handlers
    PeerReviewHandler,
    EmbeddingHandler,
    HealthCheckHandler,
    DelegateResearchHandler,
    // Required by handlers
    ReviewAgentHelper,
  ],
  exports: [
    A2AServer,
    AgentCardService,
    A2AAuthService,
    TaskRouter,
    A2AClientModule,
  ],
})
export class A2AModule {}
