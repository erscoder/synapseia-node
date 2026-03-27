import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain.js';
import { AgentLoopHelper } from './agent-loop.js';
import { WorkOrderAgentHelper } from './work-order-agent.js';
import { ReviewAgentHelper } from './review-agent.js';
import { RoundListenerHelper } from './round-listener.js';
import { AgentBrainService } from './services/agent-brain.service.js';
import { AgentLoopService } from './services/agent-loop.service.js';
import { WorkOrderAgentService } from './services/work-order-agent.service.js';

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
  exports: [AgentBrainService, AgentLoopService, WorkOrderAgentService],
})
export class AgentModule {}
