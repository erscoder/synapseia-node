import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain';
import { AgentLoopHelper } from './agent-loop';
import { WorkOrderAgentHelper } from './work-order-agent';
import { ReviewAgentHelper } from './review-agent';
import { RoundListenerHelper } from './round-listener';
import { AgentLoopService } from './services/agent-loop.service';
import { WorkOrderAgentService } from './services/work-order-agent.service';
import { WorkOrderStateHelper } from './work-order/work-order.state';
import { WorkOrderCoordinatorHelper } from './work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from './work-order/work-order.evaluation';
import { WorkOrderExecutionHelper } from './work-order/work-order.execution';
import { WorkOrderLoopHelper } from './work-order/work-order.loop';

@Module({
  imports: [],
  providers: [
    AgentBrainHelper,
    AgentLoopHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    // Work order sub-helpers (new granular classes)
    WorkOrderStateHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    WorkOrderLoopHelper,
    // Legacy facade — still used by WorkOrderAgentService
    WorkOrderAgentHelper,
    AgentLoopService,
    WorkOrderAgentService,
  ],
  exports: [
    AgentLoopService,
    WorkOrderAgentService,
    RoundListenerHelper,
    // Export sub-helpers for LangGraph nodes etc.
    WorkOrderStateHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    WorkOrderLoopHelper,
  ],
})
export class AgentModule {}
