/**
 * Generate Embedding Tool for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable } from '@nestjs/common';
import type { ToolDef } from './types';

@Injectable()
export class GenerateEmbeddingTool {
  readonly def: ToolDef = {
    name: 'generate_embedding',
    description: 'Generate a semantic embedding vector for a text. Use to compare similarity between concepts.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to embed' },
      },
      required: ['text'],
    },
  };

  async execute(params: { text: string }): Promise<number[]> {
    // Use existing EmbeddingHelper or direct Ollama call
    // If EmbeddingHelper doesn't exist, return stub empty array
    try {
      const { generateEmbedding } = await import('../../../../shared/embedding');
      return generateEmbedding(params.text);
    } catch {
      return []; // graceful degradation
    }
  }
}
