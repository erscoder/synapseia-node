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

@Module({
  imports: [A2AClientModule],
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
