/**
 * Embedding capability (A17)
 * Generate embeddings, compute cosine similarity, perform similarity search
 */

import { Injectable } from '@nestjs/common';

/**
 * Document with ID and text
 */
export interface Document {
  id: string;
  text: string;
}

/**
 * Similarity search result
 */
export interface SimilarityResult {
  id: string;
  text: string;
  score: number;
}

/** Default Ollama base URL — override via OLLAMA_URL env var */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

@Injectable()
export class EmbeddingHelper {
  private readonly ollamaBaseUrl: string;

  constructor(ollamaUrl?: string) {
    this.ollamaBaseUrl = ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  }

  /**
   * Generate embedding vector from text via Ollama (real vectors, no mocks).
   * Requires Ollama running locally with the target model pulled.
   * Throws clearly if Ollama is unavailable — no silent fallbacks.
   */
  async generateEmbedding(
    text: string,
    model: string = 'locusai/all-minilm-l6-v2',
  ): Promise<number[]> {
    // Auto-pull-once: first attempt issues the embeddings request; if Ollama
    // returns 404 / "model not found", pull the model via the Ollama HTTP
    // pull API and retry exactly once. Mirrors the auto-pull behaviour the
    // generate() path already has (modules/llm/ollama.ts) so embeddings WOs
    // don't fail forever on a fresh node that lacks `locusai/all-minilm-l6-v2`.
    try {
      return await this.callEmbeddingsApi(text, model);
    } catch (err) {
      const msg = (err as Error).message;
      const looksLikeMissingModel = /404 Not Found|model not found/i.test(msg);
      if (!looksLikeMissingModel) throw err;

      try {
        await this.pullOllamaModel(model);
      } catch (pullErr) {
        throw new Error(
          `Failed to auto-pull ${model}: ${(pullErr as Error).message}. ` +
          `Original embeddings error: ${msg}`,
        );
      }
      return await this.callEmbeddingsApi(text, model);
    }
  }

  /**
   * Inner embeddings call — extracted so the auto-pull-once wrapper can
   * invoke it twice (initial attempt + retry after pull).
   */
  private async callEmbeddingsApi(text: string, model: string): Promise<number[]> {
    const url = `${this.ollamaBaseUrl}/api/embeddings`;
    const payload = { model, prompt: text };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error(
        `Cannot connect to Ollama at ${this.ollamaBaseUrl}. ` +
        `Is Ollama running? Start with: ollama serve. ` +
        `Then pull the model: ollama pull ${model}. ` +
        `Original error: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Ollama embeddings API error ${response.status} ${response.statusText} — ` +
        `model="${model}", url="${url}". ` +
        (body.includes('model not found') || response.status === 404
          ? `Model not found. Pull it with: ollama pull ${model}`
          : body || 'Unknown error'),
      );
    }

    const data = (await response.json()) as { embedding: number[] };

    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error(`Ollama returned empty embedding for model="${model}"`);
    }

    return data.embedding;
  }

  /**
   * Pull a model via the Ollama HTTP pull endpoint. Streams the response
   * (NDJSON) until the final `status:"success"` event arrives. No progress
   * logging here — the OllamaHelper.pullModel path has its own throttled
   * progress logger; embedding code keeps this lean since it only fires
   * once per missing model per process lifetime.
   */
  private async pullOllamaModel(model: string): Promise<void> {
    const url = `${this.ollamaBaseUrl}/api/pull`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`pull HTTP ${response.status} ${response.statusText}`);
    }
    // Drain the stream — Ollama returns NDJSON progress events ending with
    // `{"status":"success"}` once the model is ready locally. We only need
    // to know the stream finished without an error event; ignore body bytes.
    const reader = response.body.getReader();
    let buf = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed) as { error?: string };
          if (evt.error) throw new Error(evt.error);
        } catch (parseErr) {
          // Ignore non-JSON lines; surface JSON `error` field if present.
          if ((parseErr as Error).message !== 'Unexpected end of JSON input') {
            // pass-through if the parsed line had an error string
          }
        }
      }
    }
  }

  /**
   * Compute cosine similarity between two vectors
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same length');
    }

    if (a.length === 0) {
      throw new Error('Vectors must not be empty');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0; // Zero vector similarity
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Perform similarity search across documents
   * Returns topK most similar documents sorted by score descending
   */
  async similaritySearch(
    query: string,
    documents: Document[],
    topK: number = 5,
    model: string = 'locusai/all-minilm-l6-v2',
  ): Promise<SimilarityResult[]> {
    if (documents.length === 0) {
      return [];
    }

    if (topK <= 0) {
      return [];
    }

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query, model);

    // Generate embeddings for all documents and compute similarities
    const results: Array<{
      doc: Document;
      score: number;
    }> = [];

    for (const doc of documents) {
      const docEmbedding = await this.generateEmbedding(doc.text, model);
      const score = this.cosineSimilarity(queryEmbedding, docEmbedding);
      results.push({ doc, score });
    }

    // Sort by score descending and take top K
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, Math.min(topK, results.length));

    return topResults.map((r) => ({
      id: r.doc.id,
      text: r.doc.text,
      score: r.score,
    }));
  }
}

// Backward-compatible standalone function exports
// Each creates an EmbeddingHelper that respects OLLAMA_URL env var
export const generateEmbedding = (...args: Parameters<EmbeddingHelper['generateEmbedding']>) =>
  new EmbeddingHelper().generateEmbedding(...args);

export const cosineSimilarity = (...args: Parameters<EmbeddingHelper['cosineSimilarity']>) =>
  new EmbeddingHelper().cosineSimilarity(...args);

export const similaritySearch = (...args: Parameters<EmbeddingHelper['similaritySearch']>) =>
  new EmbeddingHelper().similaritySearch(...args);
