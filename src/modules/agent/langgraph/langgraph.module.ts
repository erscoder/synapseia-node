import { Module } from '@nestjs/common';
import { NodesModule } from './nodes/nodes.module';
import { ToolsModule } from './tools/tools.module';
import { WorkOrderModule } from '../work-order/work-order.module';
import { LangGraphLlmService } from './llm.service';
import { AgentGraphService } from './agent-graph.service';
import { CheckpointService } from './checkpoint.service';
import { LlmProviderHelper } from '../../llm/llm-provider';
import { AgentBrainHelper } from '../agent-brain';

@Module({
  imports: [NodesModule, ToolsModule, WorkOrderModule],
  providers: [
    LangGraphLlmService,
    LlmProviderHelper,
    AgentBrainHelper,
    CheckpointService,
    AgentGraphService,
  ],
  exports: [AgentGraphService, LangGraphLlmService, AgentBrainHelper, CheckpointService, NodesModule, WorkOrderModule],
})
export class LanggraphModule {}
