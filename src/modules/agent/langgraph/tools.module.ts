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

@Module({
  providers: [SearchCorpusTool, QueryKgTool, GenerateEmbeddingTool, ToolRegistry, ToolRunnerService],
  exports: [ToolRegistry, ToolRunnerService],
})
export class ToolsModule {}
