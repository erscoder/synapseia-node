import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain';
import { AgentLoopHelper } from './agent-loop';
import { WorkOrderAgentHelper } from './work-order-agent';
import { ReviewAgentHelper } from './review-agent';
import { RoundListenerHelper } from './round-listener';
import { AgentLoopService } from './services/agent-loop.service';
import { WorkOrderAgentService } from './services/work-order-agent.service';

@Module({
  imports: [],
  providers: [
    AgentBrainHelper,
    AgentLoopHelper,
    WorkOrderAgentHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    AgentLoopService,
    WorkOrderAgentService,
  ],
  exports: [
    AgentLoopService,
    WorkOrderAgentService,
    RoundListenerHelper,
  ],
})
export class AgentModule {}
