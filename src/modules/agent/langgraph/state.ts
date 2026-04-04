/**
 * LangGraph Agent State Definition
 * Sprint A - LangGraph Foundation for Synapseia Node
 */

import type { AgentBrain } from '../agent-brain';
import type { WorkOrderAgentConfig } from '../work-order/work-order.types';
import type { WorkOrder, ResearchResult, WorkOrderEvaluation } from '../work-order/work-order.types';

// Re-export types used in state
export type { WorkOrder, ResearchResult, WorkOrderEvaluation, AgentBrain };

/**
 * Execution step for multi-step planning (Sprint B)
 */
export interface ExecutionStep {
  id: string;
  action: 'fetch_context' | 'analyze_paper' | 'cross_reference' | 'generate_hypothesis' | 'peer_review_prep';
  description: string;
}

/**
 * Memory entry from agent brain (re-export for state usage)
 */
export interface MemoryEntry {
  timestamp: number;
  type: 'experiment' | 'discovery' | 'failure';
  content: string;
  importance: number;
}

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

  // Sprint B - Planning + Self-Critique
  /** Relevant memories retrieved for the current work order */
  relevantMemories?: MemoryEntry[];
  /** Multi-step execution plan for research work orders */
  executionPlan?: ExecutionStep[];
  /** Current step index in the execution plan */
  currentStepIndex?: number;
  /** Self-critique score (0-10 average) */
  selfCritiqueScore?: number;
  /** Whether self-critique passed (avg >= 7.0) */
  selfCritiquePassed?: boolean;
  /** Feedback from self-critique for improvement */
  selfCritiqueFeedback?: string;
  /** Number of retries attempted */
  retryCount?: number;
  /** Multi-agent research pipeline: raw output from the researcher agent */
  researcherOutput?: string;
  /** Multi-agent research pipeline: output from the critic agent */
  criticOutput?: string;
  /** Multi-agent research pipeline: parsed payload for the current research */
  researchPayload?: { title: string; abstract: string } | null;
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
    // Sprint B - Planning + Self-Critique
    relevantMemories: [],
    executionPlan: [],
    currentStepIndex: 0,
    selfCritiqueScore: 0,
    selfCritiquePassed: false,
    selfCritiqueFeedback: '',
    retryCount: 0,
  };
}
