/**
 * LangGraph Agent StateGraph
 * Sprint A - LangGraph Foundation
 *
 * Graph flow:
 * FETCH_WORK_ORDERS → (hasWorkOrders?) → SELECT_BEST_WO → EVALUATE_ECONOMICS →
 * (shouldAccept?) → ACCEPT_WO → (routeByType?) → [EXECUTE_*] → QUALITY_GATE →
 * (shouldSubmit?) → SUBMIT_RESULT → UPDATE_MEMORY → END
 */

import { StateGraph, Annotation } from '@langchain/langgraph';
import type { WorkOrder, WorkOrderEvaluation, ResearchResult, AgentBrain } from './state';
import type { WorkOrderAgentConfig } from '../work-order-agent';
import { initBrain } from '../agent-brain';

// Node imports (ESM — no require())
import { fetchWorkOrders } from './nodes/fetch-work-orders';
import { selectBestWorkOrder } from './nodes/select-wo';
import { evaluateEconomics } from './nodes/evaluate-economics';
import { acceptWorkOrderNode } from './nodes/accept-wo';
import { executeResearch } from './nodes/execute-research';
import { executeTraining } from './nodes/execute-training';
import { executeInference } from './nodes/execute-inference';
import { executeDiloco } from './nodes/execute-diloco';
import { qualityGate } from './nodes/quality-gate';
import { submitResult } from './nodes/submit-result';
import { updateMemory } from './nodes/update-memory';
import { hasWorkOrders, shouldAccept, routeByType, shouldSubmitResult } from './edges';

export type { WorkOrder, WorkOrderEvaluation, ResearchResult, AgentBrain };

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

// Re-export nodes and edges for external use
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
  hasWorkOrders,
  shouldAccept,
  routeByType,
  shouldSubmitResult,
};

/**
 * Create the compiled LangGraph agent.
 * Uses `any` casts to work around LangGraph's strict generic typing —
 * the runtime behaviour is fully correct.
 */
/**
 * LangGraph Annotation schema for AgentState.
 * Uses LastValue reducer (last write wins) for all fields.
 */
const AgentStateAnnotation = Annotation.Root({
  availableWorkOrders: Annotation<WorkOrder[]>({ default: () => [], reducer: (_a, b) => b }),
  selectedWorkOrder: Annotation<WorkOrder | null>({ default: () => null, reducer: (_a, b) => b }),
  economicEvaluation: Annotation<WorkOrderEvaluation | null>({ default: () => null, reducer: (_a, b) => b }),
  executionResult: Annotation<{ result: string; success: boolean } | null>({ default: () => null, reducer: (_a, b) => b }),
  researchResult: Annotation<ResearchResult | null>({ default: () => null, reducer: (_a, b) => b }),
  qualityScore: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  shouldSubmit: Annotation<boolean>({ default: () => false, reducer: (_a, b) => b }),
  submitted: Annotation<boolean>({ default: () => false, reducer: (_a, b) => b }),
  accepted: Annotation<boolean>({ default: () => false, reducer: (_a, b) => b }),
  brain: Annotation<AgentBrain>({ default: () => initBrain(), reducer: (_a, b) => b }),
  iteration: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Annotation<WorkOrderAgentConfig | null>({ default: () => null, reducer: (_a: any, b: any) => b }),
  coordinatorUrl: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  peerId: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  capabilities: Annotation<string[]>({ default: () => [], reducer: (_a, b) => b }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAgentGraph(): any {
  const workflow = new StateGraph(AgentStateAnnotation);

  // ── Nodes ────────────────────────────────────────────────────────────────
  workflow.addNode('fetchWorkOrders', fetchWorkOrders);
  workflow.addNode('selectBestWorkOrder', selectBestWorkOrder);
  workflow.addNode('evaluateEconomics', evaluateEconomics);
  workflow.addNode('acceptWorkOrder', acceptWorkOrderNode);
  workflow.addNode('executeResearch', executeResearch);
  workflow.addNode('executeTraining', executeTraining);
  workflow.addNode('executeInference', executeInference);
  workflow.addNode('executeDiloco', executeDiloco);
  workflow.addNode('qualityGate', qualityGate);
  workflow.addNode('submitResult', submitResult);
  workflow.addNode('updateMemory', updateMemory);

  // ── Edges (cast to any to bypass LangGraph's strict generic node-name types) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = workflow as any;

  w.addEdge('__start__', 'fetchWorkOrders');

  // After fetch: if no WOs → END, else → select
  w.addConditionalEdges('fetchWorkOrders', hasWorkOrders, {
    selectBestWorkOrder: 'selectBestWorkOrder',
    __end__: '__end__',
  });

  w.addEdge('selectBestWorkOrder', 'evaluateEconomics');

  // Economics: accept → acceptWorkOrder, reject → retry fetchWorkOrders
  w.addConditionalEdges('evaluateEconomics', shouldAccept, {
    acceptWorkOrder: 'acceptWorkOrder',
    fetchWorkOrders: 'fetchWorkOrders',
  });

  // After accept: route to correct executor
  w.addConditionalEdges('acceptWorkOrder', routeByType, {
    executeResearch: 'executeResearch',
    executeTraining: 'executeTraining',
    executeInference: 'executeInference',
    executeDiloco: 'executeDiloco',
  });

  // All executors → quality gate
  w.addEdge('executeResearch', 'qualityGate');
  w.addEdge('executeTraining', 'qualityGate');
  w.addEdge('executeInference', 'qualityGate');
  w.addEdge('executeDiloco', 'qualityGate');

  // Quality gate: pass → submit, fail → update memory (skip submit)
  w.addConditionalEdges('qualityGate', shouldSubmitResult, {
    submitResult: 'submitResult',
    updateMemory: 'updateMemory',
  });

  w.addEdge('submitResult', 'updateMemory');
  w.addEdge('updateMemory', '__end__');

  return workflow.compile();
}

/**
 * Run a single iteration of the agent graph.
 * Main entry point when AGENT_MODE=langgraph.
 */
export async function runLangGraphIteration(
  config: WorkOrderAgentConfig,
  iteration: number,
  brain?: AgentBrain
): Promise<{ completed: boolean; workOrder?: WorkOrder | null }> {
  const graph = createAgentGraph();

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (graph.invoke as any)(initialState);

  return {
    completed: result.submitted ?? false,
    workOrder: result.selectedWorkOrder ?? null,
  };
}
