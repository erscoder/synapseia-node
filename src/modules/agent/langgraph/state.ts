/**
 * LangGraph Agent State Definition
 * Sprint A - LangGraph Foundation for Synapseia Node
 */

import type { AgentBrain } from '../agent-brain';
import type { WorkOrderAgentConfig } from '../work-order-agent';
import type { WorkOrder, ResearchResult, WorkOrderEvaluation } from '../work-order-agent';

// Re-export types used in state
export type { WorkOrder, ResearchResult, WorkOrderEvaluation, AgentBrain };

/**
 * AgentState - The complete state for the LangGraph agent
 * This represents all the data that flows through the graph
 */
export interface AgentState {
  // Input
  /** Work orders available from the coordinator */
  availableWorkOrders: WorkOrder[];

  // Selection
  /** The currently selected work order to process */
  selectedWorkOrder: WorkOrder | null;
  /** Economic evaluation of the selected work order */
  economicEvaluation: WorkOrderEvaluation | null;

  // Execution
  /** Result from executing the work order */
  executionResult: { result: string; success: boolean } | null;
  /** Parsed research result (only for research work orders) */
  researchResult: ResearchResult | null;

  // Quality
  /** Quality score for the execution result */
  qualityScore: number;
  /** Whether the result should be submitted based on quality gate */
  shouldSubmit: boolean;

  // Memory
  /** The agent's brain/memory for learning */
  brain: AgentBrain;

  // Control
  /** Current iteration number */
  iteration: number;
  /** Whether the work order was accepted */
  accepted: boolean;
  /** Whether the result was submitted */
  submitted: boolean;
  /** Configuration for the agent */
  config: WorkOrderAgentConfig;
  /** Coordinator URL */
  coordinatorUrl: string;
  /** This node's peer ID */
  peerId: string;
  /** This node's capabilities */
  capabilities: string[];
}

/**
 * Create the initial state for the agent graph
 */
export function createInitialAgentState(config: WorkOrderAgentConfig): AgentState {
  return {
    availableWorkOrders: [],
    selectedWorkOrder: null,
    economicEvaluation: null,
    executionResult: null,
    researchResult: null,
    qualityScore: 0,
    shouldSubmit: false,
    brain: {
      goals: [],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.5,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    },
    iteration: 0,
    accepted: false,
    submitted: false,
    config,
    coordinatorUrl: config.coordinatorUrl,
    peerId: config.peerId,
    capabilities: config.capabilities,
  };
}
