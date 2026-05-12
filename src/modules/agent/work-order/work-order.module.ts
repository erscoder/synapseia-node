import { Module } from '@nestjs/common';
import { WorkOrderStateHelper } from './work-order.state';
import { WorkOrderCoordinatorModule } from './work-order-coordinator.module';
import { WorkOrderEvaluationHelper } from './work-order.evaluation';
import { WorkOrderExecutionHelper } from './work-order.execution';
import { BackpressureService } from './backpressure.service';
import { WorkOrderPushQueue } from './work-order-push-queue';
import { LlmModule } from '../../llm/llm.module';
import { RoundListenerHelper } from '../round-listener';
import { ReviewAgentHelper } from '../review-agent';
import { AgentBrainHelper } from '../agent-brain';
import { CommitRevealV2Helper } from '../commit-reveal-v2';
import { ToolsModule } from '../langgraph/tools/tools.module';
import { IdentityModule } from '../../identity/identity.module';

@Module({
  imports: [LlmModule, ToolsModule, IdentityModule, WorkOrderCoordinatorModule],
  providers: [
    RoundListenerHelper,
    ReviewAgentHelper,
    AgentBrainHelper,
    CommitRevealV2Helper,
    WorkOrderStateHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    BackpressureService,
    {
      // Single shared queue. node-runtime registers the gossip subscription
      // that pushes into it; the LangGraph agent service drains it at
      // iteration start. Phase 2A.
      provide: WorkOrderPushQueue,
      useFactory: () => new WorkOrderPushQueue(),
    },
  ],
  // Re-export WorkOrderCoordinatorModule so downstream consumers that
  // already import WorkOrderModule keep getting the coordinator helper
  // transparently, without chasing the new module layout.
  exports: [
    WorkOrderCoordinatorModule,
    WorkOrderStateHelper,
    WorkOrderEvaluationHelper,
    WorkOrderExecutionHelper,
    BackpressureService,
    WorkOrderPushQueue,
  ],
})
export class WorkOrderModule {}
