import { Injectable } from '@nestjs/common';
import { StateGraph, Annotation } from '@langchain/langgraph';
import type { AgentState, WorkOrder, WorkOrderEvaluation, ResearchResult, AgentBrain, MemoryEntry, ExecutionStep } from './state';
import type { WorkOrderAgentConfig } from '../work-order/work-order.types';
import { AgentBrainHelper } from '../agent-brain';
import { CheckpointService } from './checkpoint.service';
import { BackpressureService } from '../work-order/backpressure.service';
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
import { ResearcherNode } from './nodes/researcher-node';
import { CriticNode } from './nodes/critic-node';
import { SynthesizerNode } from './nodes/synthesizer-node';
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
  brain: Annotation<AgentBrain | null>({ default: () => null, reducer: (_a: any, b: any) => b }),
  iteration: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  config: Annotation<WorkOrderAgentConfig | null>({ default: () => null, reducer: (_a: any, b: any) => b }),
  coordinatorUrl: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  peerId: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  // Solana wallet base58 address — required by accept/complete/submit
  // bodies. LangGraph drops fields that aren't annotated, which is
  // why the previous `initialState.walletAddress` assignment didn't
  // survive into accept-wo / submit-result.
  walletAddress: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  capabilities: Annotation<string[]>({ default: () => [], reducer: (_a, b) => b }),
  relevantMemories: Annotation<MemoryEntry[]>({ default: () => [], reducer: (_a, b) => b }),
  executionPlan: Annotation<ExecutionStep[]>({ default: () => [], reducer: (_a, b) => b }),
  currentStepIndex: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  selfCritiqueScore: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  selfCritiquePassed: Annotation<boolean>({ default: () => false, reducer: (_a, b) => b }),
  selfCritiqueFeedback: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  retryCount: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  // Multi-agent research pipeline state
  researcherOutput: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  criticOutput: Annotation<string>({ default: () => '', reducer: (_a, b) => b }),
  researchPayload: Annotation<{ title: string; abstract: string } | null>({ default: () => null, reducer: (_a: any, b: any) => b }),
  rejectedWorkOrderIds: Annotation<string[]>({ default: () => [], reducer: (_a, b) => b }),
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
    private readonly retrieveMemoryNode: RetrieveMemoryNode,
    private readonly planExecutionNode: PlanExecutionNode,
    private readonly selfCritiqueNode: SelfCritiqueNode,
    private readonly researcherNode: ResearcherNode,
    private readonly criticNode: CriticNode,
    private readonly synthesizerNode: SynthesizerNode,
    private readonly agentBrainHelper: AgentBrainHelper,
    private readonly checkpointService: CheckpointService,
    private readonly backpressure: BackpressureService,
  ) {}

  buildGraph(): any {
    const workflow = new StateGraph(AgentStateAnnotation);
    const w = workflow as any;

    // ── Nodes ────────────────────────────────────────────────────────────────
    workflow.addNode('fetchWorkOrders', (s: AgentState) => this.fetchWorkOrdersNode.execute(s));
    workflow.addNode('selectBestWorkOrder', (s: AgentState) => this.selectWorkOrderNode.execute(s));
    workflow.addNode('evaluateEconomics', (s: AgentState) => this.evaluateEconomicsNode.execute(s));
    workflow.addNode('acceptWorkOrder', (s: AgentState) => this.acceptWorkOrderNode.execute(s));
    workflow.addNode('retrieveMemory', (s: AgentState) => this.retrieveMemoryNode.execute(s));
    workflow.addNode('planExecution', (s: AgentState) => this.planExecutionNode.execute(s));
    workflow.addNode('selfCritique', (s: AgentState) => this.selfCritiqueNode.execute(s));
    // Multi-agent research pipeline (3-agent team)
    workflow.addNode('researcher', (s: AgentState) => this.researcherNode.execute(s));
    workflow.addNode('critic', (s: AgentState) => this.criticNode.execute(s));
    workflow.addNode('synthesizer', (s: AgentState) => this.synthesizerNode.execute(s));
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

    // After accepting: only continue if coordinator confirmed acceptance
    w.addConditionalEdges('acceptWorkOrder',
      (s: AgentState) => s.accepted ? 'retrieveMemory' : '__end__',
      { retrieveMemory: 'retrieveMemory', __end__: '__end__' },
    );

    // After memory retrieval, plan execution for research WOs
    w.addEdge('retrieveMemory', 'planExecution');

    // After planning, route to appropriate executor based on WO type
    w.addConditionalEdges('planExecution',
      (s: AgentState) => {
        switch (s.selectedWorkOrder?.type) {
          case 'RESEARCH':       return 'researcher';
          case 'TRAINING':       return 'executeTraining';
          case 'CPU_INFERENCE':  return 'executeInference';
          case 'GPU_INFERENCE':  return 'executeInference';
          case 'DILOCO_TRAINING':return 'executeDiloco';
          default:               return 'executeTraining';
        }
      },
      {
        researcher: 'researcher',
        executeTraining: 'executeTraining',
        executeInference: 'executeInference',
        executeDiloco: 'executeDiloco',
      },
    );

    // Multi-agent research pipeline chain: researcher → critic → synthesizer → selfCritique
    w.addEdge('researcher', 'critic');
    w.addEdge('critic', 'synthesizer');
    w.addEdge('synthesizer', 'selfCritique');
    w.addEdge('executeTraining', 'qualityGate');
    w.addEdge('executeInference', 'qualityGate');
    w.addEdge('executeDiloco', 'qualityGate');
    w.addEdge('executeResearch', 'qualityGate');

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

    return workflow.compile({
      checkpointer: this.checkpointService.getCheckpointer(),
    });
  }

  async runIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
    workOrderId?: string,
  ): Promise<{ completed: boolean; workOrder?: WorkOrder | null }> {
    const graph = this.buildGraph();

    // Derive a thread_id for checkpointing. When a specific work order ID is
    // known upfront we use it; otherwise fall back to a per-iteration id so
    // the checkpointer can still track partial progress within one invoke().
    const effectiveWoId = workOrderId ?? `iter_${iteration}`;
    const threadId = this.checkpointService.threadIdForWorkOrder(effectiveWoId);
    this.checkpointService.registerThread(threadId, effectiveWoId);

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
      brain: brain ?? this.agentBrainHelper.initBrain(),
      iteration,
      config,
      coordinatorUrl: config.coordinatorUrl,
      peerId: config.peerId,
      walletAddress: config.walletAddress,
      capabilities: config.capabilities,
      // Sprint B initial state
      relevantMemories: [],
      executionPlan: [],
      currentStepIndex: 0,
      selfCritiqueScore: 0,
      selfCritiquePassed: false,
      selfCritiqueFeedback: '',
      retryCount: 0,
      rejectedWorkOrderIds: [],
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (graph.invoke as any)(initialState, {
        configurable: { thread_id: threadId },
      });

      logger.log(`[AgentGraph] iteration=${iteration} thread=${threadId} submitted=${result.submitted}`);
      this.checkpointService.completeThread(threadId);

      // Release backpressure slot if a WO was accepted during this iteration
      if (result.selectedWorkOrder?.id) {
        this.backpressure.release(result.selectedWorkOrder.id);
      }

      return { completed: result.submitted ?? false, workOrder: result.selectedWorkOrder ?? null };
    } catch (error) {
      // Thread stays registered as incomplete on failure so
      // logIncompleteThreads() can report it on next startup.
      logger.error(`[AgentGraph] iteration=${iteration} thread=${threadId} failed:`, (error as Error).message);
      throw error;
    }
  }
}
