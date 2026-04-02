/**
 * Node: updateMemory
 * Extracts saveResearchToBrain + saveBrainToDisk logic
 * Returns { brain }
 * Sprint A - LangGraph Foundation
 */

import type { AgentState } from '../state';
import { saveResearchToBrain as saveResearchToBrainLegacy, isResearchWorkOrder } from '../../work-order-agent';
import { saveBrainToDisk } from '../../agent-brain';
import logger from '../../../../utils/logger';
import type { AgentBrain } from '../../agent-brain';

/**
 * Update the agent's brain with the work order result
 * - Saves research results to brain journal and memory
 * - Persists brain to disk
 */
export function updateMemory(state: AgentState): Partial<AgentState> {
  const { selectedWorkOrder, researchResult, brain, executionResult } = state;

  let updatedBrain = brain;

  // Only save to brain if execution was successful and we have a research result
  if (selectedWorkOrder && researchResult && executionResult?.success) {
    if (isResearchWorkOrder(selectedWorkOrder)) {
      // Save research to brain using legacy function (which modifies in place)
      saveResearchToBrainLegacy(brain, selectedWorkOrder, researchResult);
      
      // Persist to disk
      saveBrainToDisk(brain);
      logger.log(' Research saved to agent brain');
    }
  }

  return { brain: updatedBrain };
}
