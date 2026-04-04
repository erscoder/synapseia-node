import { Injectable } from '@nestjs/common';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { AgentBrainHelper } from '../../agent-brain';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class UpdateMemoryNode {
  private readonly execution: WorkOrderExecutionHelper;

  constructor(
    private readonly execution: WorkOrderExecutionHelper,
    private readonly agentBrainHelper: AgentBrainHelper,
  ) {}

  execute(state: AgentState): Partial<AgentState> {
    const { selectedWorkOrder, researchResult, brain } = state;

    if (selectedWorkOrder && researchResult && brain) {
      this.execution.saveResearchToBrain(brain, selectedWorkOrder, researchResult);
      this.agentBrainHelper.saveBrainToDisk(brain);
      logger.log(' Research saved to agent brain');
    }

    return { brain };
  }
}
