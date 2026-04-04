import { Module } from '@nestjs/common';
import { FetchWorkOrdersNode } from './fetch-work-orders';
import { SelectWorkOrderNode } from './select-wo';
import { EvaluateEconomicsNode } from './evaluate-economics';
import { AcceptWorkOrderNode } from './accept-wo';
import { ExecuteResearchNode } from './execute-research';
import { ExecuteTrainingNode } from './execute-training';
import { ExecuteInferenceNode } from './execute-inference';
import { ExecuteDilocoNode } from './execute-diloco';
import { QualityGateNode } from './quality-gate';
import { SubmitResultNode } from './submit-result';
import { UpdateMemoryNode } from './update-memory';
import { RetrieveMemoryNode } from './retrieve-memory';
import { PlanExecutionNode } from './plan-execution';
import { SelfCritiqueNode } from './self-critique';
import { ResearcherNode } from './researcher-node';
import { CriticNode } from './critic-node';
import { SynthesizerNode } from './synthesizer-node';

@Module({
  providers: [
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
