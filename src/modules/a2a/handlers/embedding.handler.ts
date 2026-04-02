/**
 * Embedding Handler
 * Sprint D — A2A Server for Synapseia Node
 *
 * Generates semantic embeddings for text using the existing EmbeddingHelper.
 */

import { Injectable } from '@nestjs/common';
import { EmbeddingHelper } from '../../../shared/embedding';

export interface EmbeddingPayload {
  text: string;
  model?: string;
}

@Injectable()
export class EmbeddingHandler {
  private readonly embeddingHelper: EmbeddingHelper;

  constructor() {
    this.embeddingHelper = new EmbeddingHelper();
  }

  /**
   * Handle an embedding request.
   * payload: { text: string, model?: string }
   * Returns: { embedding: number[], model: string, dimensions: number }
   */
  async handle(payload: Record<string, unknown>): Promise<unknown> {
    const text = payload['text'] as string;
    const model = (payload['model'] as string | undefined) ?? 'locusai/all-minilm-l6-v2';

    if (!text || typeof text !== 'string') {
      throw new Error('embedding_request payload requires text (string)');
    }

    try {
      const embedding = await this.embeddingHelper.generateEmbedding(text, model);
      return {
        embedding,
        model,
        dimensions: embedding.length,
      };
    } catch (err) {
      // Return graceful error response rather than throwing
      // This allows the task router to handle it as a failed task
      return {
        error: (err as Error).message,
        model,
        dimensions: 0,
      };
    }
  }
}
