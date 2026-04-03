/**
 * Tools Module for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Module } from '@nestjs/common';
import { ToolRegistry } from './tools/tool-registry';
import { ToolRunnerService } from './tools/tool-runner.service';
import { SearchCorpusTool } from './tools/search-corpus.tool';
import { QueryKgTool } from './tools/query-kg.tool';
import { GenerateEmbeddingTool } from './tools/generate-embedding.tool';
// Sprint E: A2A peer tools
import { DelegateToPeerTool } from './tools/delegate-peer.tool';
import { RequestPeerReviewTool } from './tools/request-peer-review.tool';
import { A2AClientModule } from '../../a2a/client/client.module';

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
