import { Module } from '@nestjs/common';
import { WorkOrderModule } from '../../work-order/work-order.module';
import { FetchWorkOrdersNode } from './fetch-work-orders';
import { SelectWorkOrderNode } from './select-wo';
import { EvaluateEconomicsNode } from './evaluate-economics';
import { AcceptWorkOrderNode } from './accept-wo';
import { ExecuteResearchNode } from './execute-research';
import { ExecuteTrainingNode } from './execute-training';
import { ExecuteInferenceNode } from './execute-inference';
import { ExecuteDilocoNode } from './execute-diloco';
import { ExecuteDockingNode } from './execute-docking';
import { ExecuteLoraNode } from './execute-lora';
import { ExecuteLoraValidationNode } from './execute-lora-validation';
import { UnknownTypeNode } from './unknown-type';
import { QualityGateNode } from './quality-gate';
import { SubmitResultNode } from './submit-result';
import { UpdateMemoryNode } from './update-memory';
import { RetrieveMemoryNode } from './retrieve-memory';
import { PlanExecutionNode } from './plan-execution';
import { SelfCritiqueNode } from './self-critique';
import { ResearcherNode } from './researcher-node';
import { CriticNode } from './critic-node';
import { SynthesizerNode } from './synthesizer-node';
import { ToolsModule } from '../tools/tools.module';
import { LangGraphLlmService } from '../llm.service';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { AgentBrainHelper } from '../../agent-brain';

@Module({
  imports: [WorkOrderModule, ToolsModule],
  providers: [
    LangGraphLlmService,
    LlmProviderHelper,
    AgentBrainHelper,
    FetchWorkOrdersNode,
    SelectWorkOrderNode,
    EvaluateEconomicsNode,
    AcceptWorkOrderNode,
    ExecuteResearchNode,
    ExecuteTrainingNode,
    ExecuteInferenceNode,
    ExecuteDilocoNode,
    ExecuteDockingNode,
    ExecuteLoraNode,
    ExecuteLoraValidationNode,
    UnknownTypeNode,
    QualityGateNode,
    SubmitResultNode,
    UpdateMemoryNode,
    RetrieveMemoryNode,
    PlanExecutionNode,
    SelfCritiqueNode,
    ResearcherNode,
    CriticNode,
    SynthesizerNode,
  ],
  exports: [
    FetchWorkOrdersNode,
    SelectWorkOrderNode,
    EvaluateEconomicsNode,
    AcceptWorkOrderNode,
    ExecuteResearchNode,
    ExecuteTrainingNode,
    ExecuteInferenceNode,
    ExecuteDilocoNode,
    ExecuteDockingNode,
    ExecuteLoraNode,
    ExecuteLoraValidationNode,
    UnknownTypeNode,
    QualityGateNode,
    SubmitResultNode,
    UpdateMemoryNode,
    RetrieveMemoryNode,
    PlanExecutionNode,
    SelfCritiqueNode,
    ResearcherNode,
    CriticNode,
    SynthesizerNode,
  ],
})
export class NodesModule {}
