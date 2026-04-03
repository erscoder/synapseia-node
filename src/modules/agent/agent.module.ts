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

@Module({
  imports: [],
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
  ],
  exports: [
    AgentBrainHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    AgentLoopHelper,
    WorkOrderStateHelper,
    WorkOrderCoordinatorHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    WorkOrderLoopHelper,
  ],
})
export class AgentModule {}
