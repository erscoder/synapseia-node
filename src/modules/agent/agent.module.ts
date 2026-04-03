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
// Sprint A-C: LangGraph agent graph
import { LanggraphModule } from './langgraph/langgraph.module';
import { LangGraphWorkOrderAgentService } from './services/langgraph-work-order-agent.service';

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
    // Agent loop (legacy)
    AgentLoopHelper,
    // LangGraph agent loop (AGENT_MODE=langgraph)
    LangGraphWorkOrderAgentService,
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
