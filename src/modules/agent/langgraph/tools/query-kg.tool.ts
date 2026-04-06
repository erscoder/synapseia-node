/**
 * Query Knowledge Graph Tool for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import type { ToolDef } from './types';

@Injectable()
export class QueryKgTool {
  constructor(private readonly coordinatorHelper: WorkOrderCoordinatorHelper) {}

  readonly def: ToolDef = {
    name: 'query_knowledge_graph',
    description: 'Query the knowledge graph for broader scientific context about a topic or concept.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The research topic or concept to look up' },
        missionId: { type: 'string', description: 'Optional mission ID to scope the query' },
      },
      required: ['topic'],
    },
  };

  async execute(params: { topic: string; missionId?: string }, coordinatorUrl: string): Promise<unknown> {
    return this.coordinatorHelper.fetchKGraphContext(coordinatorUrl, params.topic, params.missionId);
  }
}
