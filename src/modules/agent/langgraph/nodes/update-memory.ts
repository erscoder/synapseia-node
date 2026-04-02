import { Injectable } from '@nestjs/common';
import { saveResearchToBrain } from '../../work-order-agent';
import { saveBrainToDisk } from '../../agent-brain';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class UpdateMemoryNode {
  execute(state: AgentState): Partial<AgentState> {
    const { selectedWorkOrder, researchResult, brain } = state;

    if (selectedWorkOrder && researchResult && brain) {
      saveResearchToBrain(brain, selectedWorkOrder, researchResult);
      saveBrainToDisk(brain);
      logger.log(' Research saved to agent brain');
    }

    return { brain };
  }
}
