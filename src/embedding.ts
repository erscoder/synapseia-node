/**
 * Embedding capability (A17)
 * Generate embeddings, compute cosine similarity, perform similarity search
 */

/**
 * Generate embedding vector from text via Ollama
 */
export async function generateEmbedding(
  text: string,
  model: string = 'all-minilm-l6-v2',
): Promise<number[]> {
  const url = 'http://localhost:11434/api/embeddings';
  const payload = {
    model,
    prompt: text,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Ollama embeddings API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * Perform similarity search across documents
 * Returns topK most similar documents sorted by score descending
 */
export async function similaritySearch(
  query: string,
  documents: Document[],
  topK: number = 5,
  model: string = 'all-minilm-l6-v2',
): Promise<SimilarityResult[]> {
  if (documents.length === 0) {
    return [];
  }

  if (topK <= 0) {
    return [];
  }

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query, model);

  // Generate embeddings for all documents and compute similarities
  const results: Array<{
    doc: Document;
    score: number;
  }> = [];

  for (const doc of documents) {
    const docEmbedding = await generateEmbedding(doc.text, model);
    const score = cosineSimilarity(queryEmbedding, docEmbedding);
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
