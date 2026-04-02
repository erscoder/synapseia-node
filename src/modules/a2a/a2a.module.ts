import { Module } from '@nestjs/common';
import { AgentCardService } from './agent-card.service';
import { A2AServer } from './a2a-server.service';
import { TaskRouter } from './task-router';
import { PeerReviewHandler } from './handlers/peer-review.handler';
import { EmbeddingHandler } from './handlers/embedding.handler';
import { HealthCheckHandler } from './handlers/health-check.handler';
import { DelegateResearchHandler } from './handlers/delegate-research.handler';
import { A2AClientModule } from './client/client.module';

// NOTE: A2AAuthService lives in A2AClientModule to break circular dep:
// A2AModule → A2AClientModule → A2AClientService → A2AAuthService

@Module({
  imports: [A2AClientModule],
  providers: [
    AgentCardService,
    // A2AAuthService provided by A2AClientModule (imported above)
    A2AServer,
    TaskRouter,
    PeerReviewHandler,
    EmbeddingHandler,
    HealthCheckHandler,
    DelegateResearchHandler,
  ],
  exports: [
    A2AServer,
    AgentCardService,
    A2AClientModule,
    TaskRouter,
  ],
})
export class A2AModule {}
