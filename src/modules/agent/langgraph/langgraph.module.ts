import { Module, forwardRef } from '@nestjs/common';
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
// Sprint C - ReAct Tool Calling
import { ToolsModule } from './tools.module';
import { LangGraphLlmService } from './llm.service';
import { AgentGraphService } from './agent-graph.service';
import { LlmProviderHelper } from '../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../work-order/work-order.coordinator';
import { AgentBrainHelper } from '../agent-brain';

const NODES = [
  FetchWorkOrdersNode,
  SelectWorkOrderNode,
  EvaluateEconomicsNode,
  AcceptWorkOrderNode,
  ExecuteResearchNode,
  ExecuteTrainingNode,
  ExecuteInferenceNode,
  ExecuteDilocoNode,
  QualityGateNode,
  SubmitResultNode,
  UpdateMemoryNode,
  // Sprint B
  RetrieveMemoryNode,
  PlanExecutionNode,
  SelfCritiqueNode,
  // Multi-agent research pipeline
  ResearcherNode,
  CriticNode,
  SynthesizerNode,
];

@Module({
  imports: [ToolsModule],
  providers: [
    ...NODES,
    LangGraphLlmService,
    LlmProviderHelper,
    WorkOrderCoordinatorHelper,
    AgentBrainHelper,
    AgentGraphService,
  ],
  exports: [AgentGraphService, LangGraphLlmService, AgentBrainHelper, ...NODES, WorkOrderCoordinatorHelper],
})
export class LanggraphModule {}
