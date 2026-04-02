import { Injectable } from '@nestjs/common';
import { WorkOrderAgentHelper } from '../../work-order-agent';
import { AgentBrainHelper } from '../../agent-brain';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class UpdateMemoryNode {
  constructor(
    private readonly workOrderAgentHelper: WorkOrderAgentHelper,
    private readonly agentBrainHelper: AgentBrainHelper,
  ) {}

  execute(state: AgentState): Partial<AgentState> {
    const { selectedWorkOrder, researchResult, brain } = state;

    if (selectedWorkOrder && researchResult && brain) {
      this.workOrderAgentHelper.saveResearchToBrain(brain, selectedWorkOrder, researchResult);
      this.agentBrainHelper.saveBrainToDisk(brain);
      logger.log(' Research saved to agent brain');
    }

    return { brain };
  }
}
