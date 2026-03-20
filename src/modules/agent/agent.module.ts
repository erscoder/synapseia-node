import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain.js';
import { AgentLoopHelper } from './agent-loop.js';
import { WorkOrderAgentHelper } from './work-order-agent.js';
import { AgentBrainService } from './services/agent-brain.service.js';
import { AgentLoopService } from './services/agent-loop.service.js';
import { WorkOrderAgentService } from './services/work-order-agent.service.js';

@Module({
  providers: [
    AgentBrainHelper,
    AgentLoopHelper,
    WorkOrderAgentHelper,
    AgentBrainService,
    AgentLoopService,
    WorkOrderAgentService,
  ],
  exports: [AgentBrainService, AgentLoopService, WorkOrderAgentService],
})
export class AgentModule {}
