import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain';
import { AgentLoopHelper } from './agent-loop';
import { WorkOrderAgentHelper } from './work-order-agent';
import { ReviewAgentHelper } from './review-agent';
import { RoundListenerHelper } from './round-listener';
import { AgentBrainService } from './services/agent-brain.service';
import { AgentLoopService } from './services/agent-loop.service';
import { WorkOrderAgentService } from './services/work-order-agent.service';
import { LangGraphWorkOrderAgentService } from './services/langgraph-work-order-agent.service';
import { LanggraphModule } from './langgraph/langgraph.module';

@Module({
  imports: [LanggraphModule],
  providers: [
    AgentBrainHelper,
    AgentLoopHelper,
    WorkOrderAgentHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    AgentBrainService,
    AgentLoopService,
    WorkOrderAgentService,
    LangGraphWorkOrderAgentService,
  ],
  exports: [
    AgentBrainService,
    AgentLoopService,
    WorkOrderAgentService,
    LangGraphWorkOrderAgentService,
    RoundListenerHelper,
  ],
})
export class AgentModule {}
