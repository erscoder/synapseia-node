/**
 * Search Corpus Tool for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable } from '@nestjs/common';
import type { ToolDef } from './types';

@Injectable()
export class SearchCorpusTool {
  readonly def: ToolDef = {
    name: 'search_reference_corpus',
    description: 'Search the Synapseia research corpus for papers related to a topic. Use when you need scientific context or related work.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The research topic or question to search for' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' },
      },
      required: ['topic'],
    },
  };

  async execute(params: { topic: string; limit?: number }, coordinatorUrl: string): Promise<unknown> {
    const { fetchReferenceContext } = await import('../../work-order-agent');
    // Note: fetchReferenceContext only accepts coordinatorUrl and topic
    // The limit is hardcoded to 5 in the actual implementation
    return fetchReferenceContext(coordinatorUrl, params.topic);
  }
}
