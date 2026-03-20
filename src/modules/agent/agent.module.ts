import { Module } from '@nestjs/common';
import { AgentBrainService } from './agent-brain.service.js';
import { AgentLoopService } from './agent-loop.service.js';
import { WorkOrderAgentService } from './work-order-agent.service.js';

@Module({
  providers: [AgentBrainService, AgentLoopService, WorkOrderAgentService],
  exports: [AgentBrainService, AgentLoopService, WorkOrderAgentService],
})
export class AgentModule {}
