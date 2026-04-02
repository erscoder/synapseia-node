import { Module } from '@nestjs/common';
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
import { AgentGraphService } from './agent-graph.service';

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
];

@Module({
  providers: [...NODES, AgentGraphService],
  exports: [AgentGraphService, ...NODES],
})
export class LanggraphModule {}
