import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain';
import { AgentLoopHelper } from './agent-loop';
import { WorkOrderAgentHelper } from './work-order-agent';
import { ReviewAgentHelper } from './review-agent';
import { RoundListenerHelper } from './round-listener';
import { AgentBrainService } from './services/agent-brain.service';
import { AgentLoopService } from './services/agent-loop.service';
import { WorkOrderAgentService } from './services/work-order-agent.service';

@Module({
  providers: [
    AgentBrainHelper,
    AgentLoopHelper,
    WorkOrderAgentHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    AgentBrainService,
    AgentLoopService,
    WorkOrderAgentService,
  ],
  exports: [AgentBrainService, AgentLoopService, WorkOrderAgentService, RoundListenerHelper],
})
export class AgentModule {}
