import { Module } from '@nestjs/common';
import { WorkOrderStateHelper } from './work-order.state';
import { WorkOrderCoordinatorHelper } from './work-order.coordinator';
import { WorkOrderEvaluationHelper } from './work-order.evaluation';
import { WorkOrderExecutionHelper } from './work-order.execution';
import { WorkOrderLoopHelper } from './work-order.loop';
import { LlmModule } from '../../llm/llm.module';
import { RoundListenerHelper } from '../round-listener';
import { ReviewAgentHelper } from '../review-agent';
import { AgentBrainHelper } from '../agent-brain';
import { ToolsModule } from '../langgraph/tools/tools.module';
import { IdentityModule } from '../../identity/identity.module';

@Module({
  imports: [LlmModule, ToolsModule, IdentityModule],
  providers: [
    RoundListenerHelper,
    ReviewAgentHelper,
    AgentBrainHelper,
    WorkOrderStateHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    WorkOrderLoopHelper,
  ],
  exports: [
    WorkOrderStateHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    WorkOrderLoopHelper,
  ],
})
export class WorkOrderModule {}
