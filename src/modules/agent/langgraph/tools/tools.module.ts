/**
 * Tools Module for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Module } from '@nestjs/common';
import { ToolRegistry } from './tool-registry';
import { ToolRunnerService } from './tool-runner.service';
import { SearchCorpusTool } from './search-corpus.tool';
import { QueryKgTool } from './query-kg.tool';
import { GenerateEmbeddingTool } from './generate-embedding.tool';
// Sprint E: A2A peer tools
import { DelegateToPeerTool } from './delegate-peer.tool';
import { RequestPeerReviewTool } from './request-peer-review.tool';
import { A2AClientModule } from '../../../a2a/client/client.module';
import { IdentityModule } from '../../../identity/identity.module';
import { WorkOrderCoordinatorModule } from '../../work-order/work-order-coordinator.module';

@Module({
  // Pulling in the shared WorkOrderCoordinatorModule (instead of declaring
  // WorkOrderCoordinatorHelper locally) makes NestJS reuse the single
  // instance from the root DI container — fixes the duplicate onModuleInit
  // log and prevents divergent internal state between modules.
  imports: [A2AClientModule, IdentityModule, WorkOrderCoordinatorModule],
  providers: [
    SearchCorpusTool,
    QueryKgTool,
    GenerateEmbeddingTool,
    DelegateToPeerTool,
    RequestPeerReviewTool,
    ToolRegistry,
    ToolRunnerService,
  ],
  exports: [ToolRegistry, ToolRunnerService],
})
export class ToolsModule {}
