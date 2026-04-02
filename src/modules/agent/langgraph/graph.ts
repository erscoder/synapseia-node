/**
 * LangGraph Agent StateGraph
 * Sprint A - LangGraph Foundation
 * 
 * Builds the StateGraph<AgentState> with all nodes and edges
 * Graph flow:
 * FETCH_WORK_ORDERS → (hasWorkOrders?) → SELECT_BEST_WO → EVALUATE_ECONOMICS → 
 * (shouldAccept?) → ACCEPT_WO → ROUTE_BY_TYPE → [EXECUTE_*] → QUALITY_GATE → 
 * (shouldSubmit?) → SUBMIT_RESULT → UPDATE_MEMORY → END
 * 
 * Note: Uses TypeScript ignores for LangGraph API type compatibility.
 * The LangGraph SDK types are complex and change across versions.
 */

import { StateGraph } from '@langchain/langgraph';
import type { WorkOrder, WorkOrderEvaluation, ResearchResult, AgentBrain } from './state.js';
import type { WorkOrderAgentConfig } from '../work-order-agent.js';
import { initBrain } from '../agent-brain.js';

/**
 * Agent state interface used by the graph
 */
export interface GraphAgentState {
  availableWorkOrders: WorkOrder[];
  selectedWorkOrder: WorkOrder | null;
  economicEvaluation: WorkOrderEvaluation | null;
  executionResult: { result: string; success: boolean } | null;
  researchResult: ResearchResult | null;
  qualityScore: number;
  shouldSubmit: boolean;
  submitted: boolean;
  accepted: boolean;
  brain: AgentBrain;
  iteration: number;
  config: WorkOrderAgentConfig | null;
  coordinatorUrl: string;
  peerId: string;
  capabilities: string[];
}

// Re-export nodes for external use
export {
  fetchWorkOrders,
  selectBestWorkOrder,
  evaluateEconomics,
  acceptWorkOrderNode,
  executeResearch,
  executeTraining,
  executeInference,
  executeDiloco,
  qualityGate,
  submitResult,
  updateMemory,
} from './nodes/index.js';

// Re-export edges for external use
export {
  hasWorkOrders,
  shouldAccept,
  routeByType,
  shouldSubmitResult,
} from './edges.js';

/**
 * Create the compiled LangGraph agent
 */
export function createAgentGraph() {
  // Import nodes dynamically to avoid circular dependencies
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodes = require('./nodes/index.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const edges = require('./edges.js');

  // Build the graph - use any to bypass strict LangGraph type checking
  // LangGraph's TypeScript types are complex and vary across versions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workflow = new StateGraph<GraphAgentState>({} as any);

  // Add all nodes
  workflow.addNode('fetchWorkOrders', nodes.fetchWorkOrders);
  workflow.addNode('selectBestWorkOrder', nodes.selectBestWorkOrder);
  workflow.addNode('evaluateEconomics', nodes.evaluateEconomics);
  workflow.addNode('acceptWorkOrder', nodes.acceptWorkOrderNode);
  workflow.addNode('executeResearch', nodes.executeResearch);
  workflow.addNode('executeTraining', nodes.executeTraining);
  workflow.addNode('executeInference', nodes.executeInference);
  workflow.addNode('executeDiloco', nodes.executeDiloco);
  workflow.addNode('qualityGate', nodes.qualityGate);
  workflow.addNode('submitResult', nodes.submitResult);
  workflow.addNode('updateMemory', nodes.updateMemory);

  // Set entry point
  workflow.addEdge('__start__', 'fetchWorkOrders');

  // Add conditional edges
  workflow.addConditionalEdges('fetchWorkOrders', edges.hasWorkOrders, {
    selectBestWorkOrder: 'selectBestWorkOrder',
    __end__: '__end__',
  });

  workflow.addEdge('selectBestWorkOrder', 'evaluateEconomics');

  workflow.addConditionalEdges('evaluateEconomics', edges.shouldAccept, {
    acceptWorkOrder: 'acceptWorkOrder',
    fetchWorkOrders: 'fetchWorkOrders',
  });

  workflow.addEdge('acceptWorkOrder', 'routeByType');

  workflow.addConditionalEdges('routeByType', edges.routeByType, {
    executeResearch: 'executeResearch',
    executeTraining: 'executeTraining',
    executeInference: 'executeInference',
    executeDiloco: 'executeDiloco',
  });

  workflow.addEdge('executeResearch', 'qualityGate');
  workflow.addEdge('executeTraining', 'qualityGate');
  workflow.addEdge('executeInference', 'qualityGate');
  workflow.addEdge('executeDiloco', 'qualityGate');

  workflow.addConditionalEdges('qualityGate', edges.shouldSubmitResult, {
    submitResult: 'submitResult',
    updateMemory: 'updateMemory',
  });

  workflow.addEdge('submitResult', 'updateMemory');
  workflow.addEdge('updateMemory', '__end__');

  // Compile the graph
  return workflow.compile();
}

/**
 * Run a single iteration of the agent graph
 * This is the main entry point for the langgraph mode
 */
export async function runLangGraphIteration(
  config: WorkOrderAgentConfig,
  iteration: number,
  brain?: AgentBrain
): Promise<{ completed: boolean; workOrder?: WorkOrder | null }> {
  const graph = createAgentGraph();

  // Initialize state
  const initialState: GraphAgentState = {
    availableWorkOrders: [],
    selectedWorkOrder: null,
    economicEvaluation: null,
    executionResult: null,
    researchResult: null,
    qualityScore: 0,
    shouldSubmit: false,
    submitted: false,
    accepted: false,
    brain: brain ?? initBrain(),
    iteration,
    config,
    coordinatorUrl: config.coordinatorUrl,
    peerId: config.peerId,
    capabilities: config.capabilities,
  };

  // Run the graph - use any to bypass strict LangGraph type checking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (graph.invoke as any)(initialState);

  return {
    completed: result.submitted,
    workOrder: result.selectedWorkOrder,
  };
}
