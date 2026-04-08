/**
 * Embedding Helper
 * Local embedding utility for the node package.
 */

export interface EmbeddingHelper {
  generateEmbedding(text: string, model?: string): Promise<number[]>;
}

export class EmbeddingHelper {
  /**
   * Generate embeddings for text via Ollama.
   * Defaults to locusai/all-minilm-l6-v2.
   */
  async generateEmbedding(text: string, model = 'locusai/all-minilm-l6-v2'): Promise<number[]> {
    const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';

    const response = await fetch(`${url}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`Embedding failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { embedding?: number[] };
    return data.embedding ?? [];
  }
}