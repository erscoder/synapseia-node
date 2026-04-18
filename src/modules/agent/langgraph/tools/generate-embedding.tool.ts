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
    // Use existing EmbeddingHelper or direct Ollama call. Graceful
    // degradation: any failure (module missing, Ollama unreachable, model
    // not pulled) returns an empty array so callers don't have to deal with
    // exceptions — the ReAct agent interprets [] as "no embedding" and
    // skips similarity-dependent branches.
    //
    // NOTE: the `await` on generateEmbedding() is load-bearing: without it
    // the promise rejection escapes the try/catch and the "graceful" path
    // never runs.
    try {
      const { generateEmbedding } = await import('../../../../shared/embedding');
      return await generateEmbedding(params.text);
    } catch {
      return [];
    }
  }
}
