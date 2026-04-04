import { Module } from '@nestjs/common';
import { NodesModule } from './nodes/nodes.module';
import { ToolsModule } from './tools/tools.module';
import { WorkOrderModule } from '../work-order/work-order.module';
import { LangGraphLlmService } from './llm.service';
import { AgentGraphService } from './agent-graph.service';
import { LlmProviderHelper } from '../../llm/llm-provider';
import { AgentBrainHelper } from '../agent-brain';

@Module({
  imports: [NodesModule, ToolsModule, WorkOrderModule],
  providers: [
    LangGraphLlmService,
    LlmProviderHelper,
    AgentBrainHelper,
    AgentGraphService,
  ],
  exports: [AgentGraphService, LangGraphLlmService, AgentBrainHelper, NodesModule, WorkOrderModule],
})
export class LanggraphModule {}
