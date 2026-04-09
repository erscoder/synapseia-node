import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { AgentBrainHelper } from './agent-brain';
import { AgentLoopHelper } from './agent-loop';
import { ReviewAgentHelper } from './review-agent';
import { RoundListenerHelper } from './round-listener';
import { WorkOrderModule } from './work-order/work-order.module';
import { LanggraphModule } from './langgraph/langgraph.module';
import { LangGraphWorkOrderAgentService } from './services/langgraph-work-order-agent.service';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [WorkOrderModule, LanggraphModule, LlmModule, IdentityModule],
  providers: [
    AgentBrainHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    AgentLoopHelper,
    LangGraphWorkOrderAgentService,
  ],
  exports: [
    AgentBrainHelper,
    ReviewAgentHelper,
    RoundListenerHelper,
    AgentLoopHelper,
    LangGraphWorkOrderAgentService,
    WorkOrderModule,
  ],
})
export class AgentModule {}
