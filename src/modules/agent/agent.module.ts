import { Module, type DynamicModule } from '@nestjs/common';
import { AgentBrainHelper } from './agent-brain';
import { AgentLoopHelper } from './agent-loop';

import { ReviewAgentHelper } from './review-agent';
import { RoundListenerHelper } from './round-listener';
import { WorkOrderStateHelper } from './work-order/work-order.state';
import { WorkOrderCoordinatorHelper } from './work-order/work-order.coordinator';
import { WorkOrderEvaluationHelper } from './work-order/work-order.evaluation';
import { WorkOrderExecutionHelper } from './work-order/work-order.execution';
import { WorkOrderLoopHelper } from './work-order/work-order.loop';

// LangGraph imports are lazy — only loaded when AGENT_MODE=langgraph
const isLangGraph = process.env.AGENT_MODE === 'langgraph';

@Module({})
export class AgentModule {
  static register(): DynamicModule {
    const imports: any[] = [];
    const extraProviders: any[] = [];
    const extraExports: any[] = [];

    if (isLangGraph) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LanggraphModule } = require('./langgraph/langgraph.module');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LangGraphWorkOrderAgentService } = require('./services/langgraph-work-order-agent.service');
      imports.push(LanggraphModule);
      extraProviders.push(LangGraphWorkOrderAgentService);
      extraExports.push(LangGraphWorkOrderAgentService);
    }

    return {
      module: AgentModule,
      imports,
      providers: [
        AgentBrainHelper,
        ReviewAgentHelper,
        RoundListenerHelper,
        // Work-order sub-helpers
        WorkOrderStateHelper,
        WorkOrderCoordinatorHelper,
        WorkOrderEvaluationHelper,
        WorkOrderExecutionHelper,
        WorkOrderLoopHelper,
        // Agent loop (legacy)
        AgentLoopHelper,
        ...extraProviders,
      ],
      exports: [
        AgentBrainHelper,
        ReviewAgentHelper,
        RoundListenerHelper,
        AgentLoopHelper,
        WorkOrderStateHelper,
        WorkOrderCoordinatorHelper,
        WorkOrderEvaluationHelper,
        WorkOrderExecutionHelper,
        WorkOrderLoopHelper,
        ...extraExports,
      ],
    };
  }
}
