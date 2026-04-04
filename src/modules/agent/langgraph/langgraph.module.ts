import { Module } from '@nestjs/common';
import { NodesModule } from './nodes/nodes.module';
import { ToolsModule } from './tools/tools.module';
import { LangGraphLlmService } from './llm.service';
import { AgentGraphService } from './agent-graph.service';
import { LlmProviderHelper } from '../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../work-order/work-order.evaluation';
import { WorkOrderExecutionHelper } from '../work-order/work-order.execution';
import { AgentBrainHelper } from '../agent-brain';

@Module({
  imports: [NodesModule, ToolsModule],
  providers: [
    LangGraphLlmService,
    LlmProviderHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    AgentBrainHelper,
    AgentGraphService,
  ],
  exports: [AgentGraphService, LangGraphLlmService, AgentBrainHelper, NodesModule, WorkOrderCoordinatorHelper],
})
export class LanggraphModule {}
