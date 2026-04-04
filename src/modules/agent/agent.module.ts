import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain';
import { AgentLoopHelper } from './agent-loop';

import { ReviewAgentHelper } from './review-agent';
import { RoundListenerHelper } from './round-listener';
import { WorkOrderStateHelper } from './work-order/work-order.state';
import { WorkOrderCoordinatorHelper } from './work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from './work-order/work-order.evaluation';
import { WorkOrderExecutionHelper } from './work-order/work-order.execution';
import { WorkOrderLoopHelper } from './work-order/work-order.loop';
import { LanggraphModule } from './langgraph/langgraph.module';
import { LangGraphWorkOrderAgentService } from './services/langgraph-work-order-agent.service';
import { ResearchTeamService } from './multi-agent';

@Module({
  imports: [LanggraphModule],
  providers: [
    AgentBrainHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    // Work-order sub-helpers
    WorkOrderStateHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    WorkOrderLoopHelper,
    // Agent loop
    AgentLoopHelper,
    // LangGraph agent loop
    LangGraphWorkOrderAgentService,
    // Multi-agent
    ResearchTeamService,
  ],
  exports: [
    AgentBrainHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    AgentLoopHelper,
    LangGraphWorkOrderAgentService,
    WorkOrderStateHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    WorkOrderLoopHelper,
  ],
})
export class AgentModule {}
