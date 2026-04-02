import { Injectable } from '@nestjs/common';
import { StateGraph, Annotation } from '@langchain/langgraph';
import type { AgentState, WorkOrder, WorkOrderEvaluation, ResearchResult, AgentBrain, MemoryEntry, ExecutionStep } from './state';
import type { WorkOrderAgentConfig } from '../work-order-agent';
import { initBrain } from '../agent-brain';
import { FetchWorkOrdersNode } from './nodes/fetch-work-orders';
import { SelectWorkOrderNode } from './nodes/select-wo';
import { EvaluateEconomicsNode } from './nodes/evaluate-economics';
import { AcceptWorkOrderNode } from './nodes/accept-wo';
import { ExecuteResearchNode } from './nodes/execute-research';
import { ExecuteTrainingNode } from './nodes/execute-training';
import { ExecuteInferenceNode } from './nodes/execute-inference';
import { ExecuteDilocoNode } from './nodes/execute-diloco';
import { QualityGateNode } from './nodes/quality-gate';
import { SubmitResultNode } from './nodes/submit-result';
import { UpdateMemoryNode } from './nodes/update-memory';
// Sprint B - Planning + Self-Critique
import { RetrieveMemoryNode } from './nodes/retrieve-memory';
import { PlanExecutionNode } from './nodes/plan-execution';
import { SelfCritiqueNode } from './nodes/self-critique';
import logger from '../../../utils/logger';

/**
 * LangGraph Annotation schema for AgentState.
 * Last-write-wins reducer for all fields.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brain: Annotation<AgentBrain>({ default: () => initBrain(), reducer: (_a: any, b: any) => b }),
  iteration: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Annotation<WorkOrderAgentConfig | null>({ default: () => null, reducer: (_a: any, b: any) => b }),
  coordinatorUrl: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  peerId: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  capabilities: Annotation<string[]>({ default: () => [], reducer: (_a, b) => b }),
  // Sprint B fields
  relevantMemories: Annotation<MemoryEntry[]>({ default: () => [], reducer: (_a, b) => b }),
  executionPlan: Annotation<ExecutionStep[]>({ default: () => [], reducer: (_a, b) => b }),
  currentStepIndex: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  selfCritiqueScore: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  selfCritiquePassed: Annotation<boolean>({ default: () => false, reducer: (_a, b) => b }),
  selfCritiqueFeedback: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  retryCount: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
});

@Injectable()
export class AgentGraphService {
  constructor(
    private readonly fetchWorkOrdersNode: FetchWorkOrdersNode,
    private readonly selectWorkOrderNode: SelectWorkOrderNode,
    private readonly evaluateEconomicsNode: EvaluateEconomicsNode,
    private readonly acceptWorkOrderNode: AcceptWorkOrderNode,
    private readonly executeResearchNode: ExecuteResearchNode,
    private readonly executeTrainingNode: ExecuteTrainingNode,
    private readonly executeInferenceNode: ExecuteInferenceNode,
    private readonly executeDilocoNode: ExecuteDilocoNode,
    private readonly qualityGateNode: QualityGateNode,
    private readonly submitResultNode: SubmitResultNode,
    private readonly updateMemoryNode: UpdateMemoryNode,
    // Sprint B nodes
    private readonly retrieveMemoryNode: RetrieveMemoryNode,
    private readonly planExecutionNode: PlanExecutionNode,
    private readonly selfCritiqueNode: SelfCritiqueNode,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildGraph(): any {
    const workflow = new StateGraph(AgentStateAnnotation);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = workflow as any;

    // ── Nodes ────────────────────────────────────────────────────────────────
    workflow.addNode('fetchWorkOrders', (s: AgentState) => this.fetchWorkOrdersNode.execute(s));
    workflow.addNode('selectBestWorkOrder', (s: AgentState) => this.selectWorkOrderNode.execute(s));
    workflow.addNode('evaluateEconomics', (s: AgentState) => this.evaluateEconomicsNode.execute(s));
    workflow.addNode('acceptWorkOrder', (s: AgentState) => this.acceptWorkOrderNode.execute(s));
    // Sprint B nodes
    workflow.addNode('retrieveMemory', (s: AgentState) => this.retrieveMemoryNode.execute(s));
    workflow.addNode('planExecution', (s: AgentState) => this.planExecutionNode.execute(s));
    workflow.addNode('selfCritique', (s: AgentState) => this.selfCritiqueNode.execute(s));
    // Execution nodes
    workflow.addNode('executeResearch', (s: AgentState) => this.executeResearchNode.execute(s));
    workflow.addNode('executeTraining', (s: AgentState) => this.executeTrainingNode.execute(s));
    workflow.addNode('executeInference', (s: AgentState) => this.executeInferenceNode.execute(s));
    workflow.addNode('executeDiloco', (s: AgentState) => this.executeDilocoNode.execute(s));
    workflow.addNode('qualityGate', (s: AgentState) => this.qualityGateNode.execute(s));
    workflow.addNode('submitResult', (s: AgentState) => this.submitResultNode.execute(s));
    workflow.addNode('updateMemory', (s: AgentState) => this.updateMemoryNode.execute(s));

    // ── Edges ─────────────────────────────────────────────────────────────────
    w.addEdge('__start__', 'fetchWorkOrders');

    w.addConditionalEdges('fetchWorkOrders',
      (s: AgentState) => s.availableWorkOrders.length > 0 ? 'selectBestWorkOrder' : '__end__',
      { selectBestWorkOrder: 'selectBestWorkOrder', __end__: '__end__' },
    );

    w.addEdge('selectBestWorkOrder', 'evaluateEconomics');

    w.addConditionalEdges('evaluateEconomics',
      (s: AgentState) => s.economicEvaluation?.shouldAccept ? 'acceptWorkOrder' : 'fetchWorkOrders',
      { acceptWorkOrder: 'acceptWorkOrder', fetchWorkOrders: 'fetchWorkOrders' },
    );

    // After accepting, retrieve memories (Sprint B)
    w.addEdge('acceptWorkOrder', 'retrieveMemory');

    // After memory retrieval, plan execution for research WOs
    w.addEdge('retrieveMemory', 'planExecution');

    // After planning, route to appropriate executor based on WO type
    w.addConditionalEdges('planExecution',
      (s: AgentState) => {
        switch (s.selectedWorkOrder?.type) {
          case 'RESEARCH':       return 'executeResearch';
          case 'TRAINING':       return 'executeTraining';
          case 'CPU_INFERENCE':  return 'executeInference';
          case 'DILOCO_TRAINING':return 'executeDiloco';
          default:               return 'executeResearch';
        }
      },
      {
        executeResearch: 'executeResearch',
        executeTraining: 'executeTraining',
        executeInference: 'executeInference',
        executeDiloco: 'executeDiloco',
      },
    );

    // After execution, self-critique for research WOs (Sprint B)
    w.addEdge('executeResearch', 'selfCritique');
    w.addEdge('executeTraining', 'qualityGate');
    w.addEdge('executeInference', 'qualityGate');
    w.addEdge('executeDiloco', 'qualityGate');

    // After self-critique, decide whether to retry or proceed to quality gate
    w.addConditionalEdges('selfCritique',
      (s: AgentState) => {
        // Only retry for research WOs that failed critique and haven't exceeded max retries
        if (s.selectedWorkOrder?.type === 'RESEARCH' && !s.selfCritiquePassed && (s.retryCount || 0) < 2) {
          return 'executeResearch'; // Retry - go back to execution
        }
        return 'qualityGate';
      },
      {
        executeResearch: 'executeResearch',
        qualityGate: 'qualityGate',
      },
    );

    w.addConditionalEdges('qualityGate',
      (s: AgentState) => s.shouldSubmit ? 'submitResult' : 'updateMemory',
      { submitResult: 'submitResult', updateMemory: 'updateMemory' },
    );

    w.addEdge('submitResult', 'updateMemory');
    w.addEdge('updateMemory', '__end__');

    return workflow.compile();
  }

  async runIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ completed: boolean; workOrder?: WorkOrder | null }> {
    const graph = this.buildGraph();

    const initialState = {
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
      // Sprint B initial state
      relevantMemories: [],
      executionPlan: [],
      currentStepIndex: 0,
      selfCritiqueScore: 0,
      selfCritiquePassed: false,
      selfCritiqueFeedback: '',
      retryCount: 0,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (graph.invoke as any)(initialState);

    logger.log(`[AgentGraph] iteration=${iteration} submitted=${result.submitted}`);
    return { completed: result.submitted ?? false, workOrder: result.selectedWorkOrder ?? null };
  }
}
