import { Module } from '@nestjs/common';
import { AgentBrainHelper } from './helpers/agent-brain.js';
import { AgentLoopHelper } from './helpers/agent-loop.js';
import { WorkOrderAgentHelper } from './helpers/work-order-agent.js';
import { AgentBrainService } from './agent-brain.service.js';
import { AgentLoopService } from './agent-loop.service.js';
import { WorkOrderAgentService } from './work-order-agent.service.js';

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
