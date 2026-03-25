/**
 * Work Order Agent - Polling loop for work order execution
 *
 * Loop principal:
 * 1. Poll /work-orders/available from coordinator
 * 2. Accept assignable work order
 * 3. Execute work (research, calculation, etc.)
 * 4. Report result to coordinator
 * 5. Sleep and repeat
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../utils/logger.js';
import { generateLLM, type LLMConfig } from '../llm/llm-provider.js';
import { parseModel, type LLMModel } from '../llm/llm-provider.js';
import type { AgentBrain } from './agent-brain.js';
import { startRoundListener } from './round-listener.js';
import { trainMicroModel } from '../model/trainer.js';
import { proposeMutation } from '../model/mutation-engine.js';
import type { Experiment } from '../../types.js';

/**
 * Parse rewardAmount string to lamports BigInt.
 * The coordinator API returns SYN as decimal string e.g. "100.000000000"
 * (9 decimal places = lamports). BigInt() cannot handle decimals, so we
 * strip the decimal point and convert directly.
 */
function parseSynToLamports(rewardStr: string): bigint {
  if (!rewardStr) return 0n;
  // If it already looks like a plain integer (no dot), convert directly
  if (!rewardStr.includes('.')) return BigInt(rewardStr);
  // "100.000000000" → integer part "100", decimal part "000000000" (9 digits)
  const [intPart, decPart = ''] = rewardStr.split('.');
  const decimals = 9;
  const paddedDec = decPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(intPart) * 1_000_000_000n + BigInt(paddedDec);
}

export interface WorkOrderAgentConfig {
  coordinatorUrl: string;
  peerId: string;
  capabilities: string[];
  llmModel: LLMModel;
  llmConfig?: LLMConfig;
  intervalMs: number;
  maxIterations?: number;
}

export interface WorkOrder {
  id: string;
  title: string;
  description: string;
  requiredCapabilities: string[];
  rewardAmount: string; // BigInt as string
  status: 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  creatorAddress: string;
  assigneeAddress?: string;
  createdAt: number;
  expiresAt?: number;
  type?: 'TRAINING' | 'RESEARCH' | 'INFERENCE';
}

export interface ResearchPayload {
  title: string;
  abstract: string;
}

export interface ResearchResult {
  summary: string;
  keyInsights: string[];
  proposal: string;
}

/**
 * Scores a ResearchResult for coherence quality (0.0 – 1.0).
 *
 * Criteria (each up to some fraction of the total):
 *  - summary:    length ≥ 80 chars → 0.3, < 20 → 0.0, linear in between
 *  - keyInsights: ≥ 3 insights → 0.3, each insight avg length ≥ 30 chars → extra 0.1
 *  - proposal:   length ≥ 100 chars → 0.3, < 20 → 0.0, linear in between
 *
 * Total max = 1.0. Rounded to 2 decimal places.
 */
export function scoreResearchResult(result: ResearchResult): number {
  let score = 0;

  // --- summary (0–0.3) ---
  const summaryLen = (result.summary ?? '').trim().length;
  if (summaryLen >= 80) {
    score += 0.3;
  } else if (summaryLen > 20) {
    score += 0.3 * ((summaryLen - 20) / 60);
  }

  // --- keyInsights (0–0.4): count + avg length bonus ---
  const insights = Array.isArray(result.keyInsights) ? result.keyInsights : [];
  const insightCount = insights.length;
  if (insightCount >= 3) {
    score += 0.3;
  } else if (insightCount > 0) {
    score += 0.3 * (insightCount / 3);
  }
  if (insightCount > 0) {
    const avgLen = insights.reduce((sum, s) => sum + (s ?? '').trim().length, 0) / insightCount;
    if (avgLen >= 30) score += 0.1;
  }

  // --- proposal (0–0.3) ---
  const proposalLen = (result.proposal ?? '').trim().length;
  if (proposalLen >= 100) {
    score += 0.3;
  } else if (proposalLen > 20) {
    score += 0.3 * ((proposalLen - 20) / 80);
  }

  return Math.round(Math.min(score, 1.0) * 100) / 100;
}

export interface WorkOrderAgentState {
  iteration: number;
  totalWorkOrdersCompleted: number;
  totalRewardsEarned: bigint;
  isRunning: boolean;
  currentWorkOrder?: WorkOrder;
  /** Work order IDs already submitted by this node in this session (non-research only) */
  completedWorkOrderIds: Set<string>;
  /** Research WO cooldowns: workOrderId → timestamp when it can be retried */
  researchCooldowns: Map<string, number>;
}

/**
 * Economic configuration for rational node behavior
 * Controls bounty evaluation and profit thresholds
 */
export interface EconomicConfig {
  /** SYN price in USD for testnet calculations */
  synPriceUsd: number;
  /** LLM type: 'ollama' (local, $0 cost) or 'cloud' (paid API) */
  llmType: 'ollama' | 'cloud';
  /** LLM model identifier (e.g., 'gpt-4o-mini', 'claude-haiku') */
  llmModel: string;
  /** Cost per 1K tokens for cloud LLMs (e.g., $0.002 for GPT-4o-mini) */
  llmCostPer1kTokens: number;
  /** Minimum profit ratio: bounty/costo must be >= this (default 1.5 = 50% profit) */
  minProfitRatio: number;
}

/**
 * Evaluation result for a work order
 */
export interface WorkOrderEvaluation {
  /** Whether the WO should be accepted */
  shouldAccept: boolean;
  /** Bounty amount in SYN */
  bountySyn: bigint;
  /** Bounty amount in USD */
  bountyUsd: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Profit ratio (bounty/cost) */
  profitRatio: number;
  /** Reason for decision */
  reason: string;
}

// Global state for the work order agent
/** Cooldown for re-analyzing a research paper (ms) — allows hyperparams diversity */
const RESEARCH_COOLDOWN_MS = parseInt(process.env.RESEARCH_COOLDOWN_MS ?? String(5 * 60 * 1000), 10); // default 5 min, override via env

let agentState: WorkOrderAgentState  = {
  iteration: 0,
  totalWorkOrdersCompleted: 0,
  totalRewardsEarned: 0n,
  isRunning: false,
  completedWorkOrderIds: new Set<string>(),
  researchCooldowns: new Map<string, number>(),
} ;

/**
 * Static price table for cloud LLM models
 * Prices in USD per 1K tokens (input+output average)
 */
const LLM_PRICE_TABLE: Record<string, number> = {
  // OpenAI models
  'gpt-4o': 0.005,
  'gpt-4o-mini': 0.00015,
  'gpt-4-turbo': 0.01,
  'gpt-3.5-turbo': 0.0005,
  
  // Anthropic models
  'claude-haiku': 0.00025,
  'claude-haiku-3': 0.00025,
  'claude-sonnet': 0.003,
  'claude-opus': 0.015,
  
  // Google models
  'gemini-flash': 0.000075,
  'gemini-pro': 0.00035,

  // MiniMax models — subscription $20/mo ÷ 4500 req ≈ $0.00444/req
  // Approximated as per-token cost assuming ~2K tokens avg per request
  'MiniMax-M2.7': 0.00222,
  'minimax/MiniMax-M2.7': 0.00222,
  
  // Ollama models (local, $0 cost)
  'ollama/phi4-mini': 0,
  'ollama/llama3': 0,
  'ollama/mistral': 0,
};

/** Default fallback price (claude-haiku) when model not found */
const DEFAULT_MODEL_PRICE = 0.00025;

/**
 * Get cost per 1K tokens for a given LLM model
 * Falls back to DEFAULT_MODEL_PRICE with warning if model not found
 */
export function getModelCostPer1kTokens(model: string): number {
  // Check exact match
  if (model in LLM_PRICE_TABLE) {
    return LLM_PRICE_TABLE[model];
  }
  
  // Check for ollama/* pattern
  if (model.startsWith('ollama/')) {
    return 0;
  }
  
  // Log warning and fallback to haiku price
  logger.warn(`Unknown model "${model}" — falling back to claude-haiku pricing ($${DEFAULT_MODEL_PRICE}/1K tokens)`);
  return DEFAULT_MODEL_PRICE;
}

/**
 * Get current agent state
 */
export function getWorkOrderAgentState(): WorkOrderAgentState {
  return { ...agentState };
}

/**
 * Reset agent state
 */
export function resetWorkOrderAgentState(): void {
  agentState = {
    iteration: 0,
    totalWorkOrdersCompleted: 0,
    totalRewardsEarned: 0n,
    isRunning: false,
    completedWorkOrderIds: new Set<string>(),
    researchCooldowns: new Map<string, number>(),
  };
}

/**
 * Fetch available work orders from coordinator
 */
export async function fetchAvailableWorkOrders(
  coordinatorUrl: string,
  peerId: string,
  capabilities: string[]
): Promise<WorkOrder[]> {
  try {
    const capabilitiesParam = capabilities.join(',');
    const url = `${coordinatorUrl}/work-orders/available?peerId=${peerId}&capabilities=${capabilitiesParam}`;

    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        // Endpoint not found - coordinator may not have work orders enabled
        return [];
      }
      throw new Error(`Failed to fetch work orders: ${response.statusText}`);
    }

    const data = await response.json() as WorkOrder[];
    return data || [];
  } catch (error) {
    logger.warn(' Failed to fetch work orders:', (error as Error).message);
    return [];
  }
}

/**
 * Accept a work order
 */
export async function acceptWorkOrder(
  coordinatorUrl: string,
  workOrderId: string,
  peerId: string,
  nodeCapabilities: string[] = []
): Promise<boolean> {
  try {
    const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workOrderId,
        assigneeAddress: peerId,
        nodeCapabilities,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn(` Failed to accept work order ${workOrderId}:`, error);
      return false;
    }

    return true;
  } catch (error) {
    logger.warn(' Failed to accept work order:', (error as Error).message);
    return false;
  }
}

/**
 * Complete a work order with result
 */
export async function completeWorkOrder(
  coordinatorUrl: string,
  workOrderId: string,
  peerId: string,
  result: string,
  success: boolean = true
): Promise<boolean> {
  try {
    const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workOrderId,
        assigneeAddress: peerId,
        result,
        success,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn(` Failed to complete work order ${workOrderId}:`, error);
      return false;
    }

    const data = await response.json() as WorkOrder;

    // Track rewards
    if (success && data.rewardAmount) {
      agentState.totalRewardsEarned += parseSynToLamports(data.rewardAmount);
    }

    return true;
  } catch (error) {
    logger.warn(' Failed to complete work order:', (error as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Training Work Order support
// ---------------------------------------------------------------------------

/** Local copy of the coordinator TrainingWorkOrderPayload shape */
export interface TrainingWorkOrderPayload {
  domain: 'medical' | 'trading' | 'ai' | 'crypto' | 'astrophysics';
  datasetId: string;
  baseConfig?: Partial<{
    learningRate: number;
    batchSize: number;
    hiddenDim: number;
    numLayers: number;
    numHeads: number;
    activation: 'gelu' | 'silu' | 'relu';
    normalization: 'layernorm' | 'rmsnorm';
    initScheme: 'xavier' | 'kaiming' | 'normal';
    warmupSteps: number;
    weightDecay: number;
    maxTrainSeconds: number;
  }>;
  maxTrainSeconds: number;
  currentBestLoss: number;
}

/**
 * Detect if work order is of type TRAINING
 */
export function isTrainingWorkOrder(workOrder: WorkOrder): boolean {
  if (workOrder.type === 'TRAINING') return true;

  // Try to parse description as JSON with training payload
  try {
    const payload = JSON.parse(workOrder.description) as Partial<TrainingWorkOrderPayload>;
    return !!(payload.domain && payload.datasetId !== undefined && payload.currentBestLoss !== undefined);
  } catch {
    return false;
  }
}

/**
 * Fetch top experiments from coordinator for mutation-engine input
 */
export async function fetchTopExperiments(coordinatorUrl: string): Promise<Experiment[]> {
  try {
    const res = await fetch(`${coordinatorUrl}/hyperparams/leaderboard`);
    if (!res.ok) return [];
    const data = await res.json() as { entries?: Array<{ config?: { id?: string }; bestScore?: number }> };
    // Map leaderboard entries to Experiment shape
    const entries = (data.entries ?? []).slice(0, 5);
    return entries.map(entry => ({
      id: entry.config?.id ?? '',
      model: '',
      hyperparams: (entry.config ?? {}) as Experiment['hyperparams'],
      valLoss: entry.bestScore ?? 999,
      status: 'completed' as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Submit training experiment to coordinator hyperparam leaderboard
 */
export async function submitTrainingExperiment(
  coordinatorUrl: string,
  peerId: string,
  config: TrainingWorkOrderPayload['baseConfig'] & { id?: string },
  valLoss: number,
  durationMs: number,
): Promise<void> {
  try {
    await fetch(`${coordinatorUrl}/hyperparams/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerId,
        config: {
          id: config?.id ?? `train_${Date.now()}`,
          temperature: 0,
          promptTemplate: 'training',
          analysisDepth: 'training',
          chunkSize: 512,
          ...config,
        },
        qualityScore: Math.max(0, Math.min(10, 10 * Math.exp(-valLoss))),
        latencyMs: durationMs,
        tokenCost: 0,
        papersTested: 1,
      }),
    });
  } catch {
    // Non-critical — don't fail the training
  }
}

/**
 * Submit training result to the /experiments endpoint
 */
export async function submitTrainingToExperiments(
  coordinatorUrl: string,
  peerId: string,
  payload: TrainingWorkOrderPayload,
  valLoss: number,
  finalLoss: number,
  durationMs: number,
): Promise<void> {
  try {
    await fetch(`${coordinatorUrl}/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerId,
        domain: payload.domain,
        datasetId: payload.datasetId,
        valLoss,
        finalLoss,
        durationMs,
        improved: valLoss < payload.currentBestLoss,
        createdAt: Date.now(),
      }),
    });
  } catch {
    // Non-critical — /experiments endpoint may not be deployed yet
  }
}

// ---------------------------------------------------------------------------
// Dataset download + caching (B4)
// ---------------------------------------------------------------------------

/** Base directory for locally cached datasets */
export function getDatasetCacheDir(): string {
  return path.join(os.homedir(), '.synapseia', 'datasets');
}

/**
 * Download the training corpus for a domain from the coordinator.
 *
 * Uses ETag / Last-Modified headers to avoid re-downloading when unchanged.
 * Caches locally at ~/.synapseia/datasets/{domain}/corpus.txt.
 *
 * @returns The local path to the cached corpus file.
 */
export async function downloadDataset(coordinatorUrl: string, domain: string): Promise<string> {
  const cacheDir = path.join(getDatasetCacheDir(), domain);
  const corpusPath = path.join(cacheDir, 'corpus.txt');
  const metaPath = path.join(cacheDir, 'cache-meta.json');

  // Ensure cache directory exists
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Load existing cache metadata (ETag / Last-Modified)
  let cachedEtag: string | undefined;
  let cachedLastModified: string | undefined;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
        etag?: string;
        lastModified?: string;
      };
      cachedEtag = meta.etag;
      cachedLastModified = meta.lastModified;
    } catch {
      // Ignore corrupt metadata
    }
  }

  const url = `${coordinatorUrl}/datasets/${domain}/corpus`;
  const headers: Record<string, string> = {};
  if (cachedEtag) {
    headers['If-None-Match'] = cachedEtag;
  } else if (cachedLastModified) {
    headers['If-Modified-Since'] = cachedLastModified;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    // Network error — return cached file if available
    if (fs.existsSync(corpusPath)) {
      logger.warn(`[Dataset] Network error fetching '${domain}' corpus; using cached version`);
      return corpusPath;
    }
    throw new Error(`Failed to download dataset for '${domain}': ${(error as Error).message}`);
  }

  if (response.status === 304) {
    // Not modified — cached version is up to date
    logger.log(`[Dataset] '${domain}' corpus unchanged (304 Not Modified)`);
    return corpusPath;
  }

  if (!response.ok) {
    if (fs.existsSync(corpusPath)) {
      logger.warn(`[Dataset] Coordinator returned ${response.status} for '${domain}'; using cached version`);
      return corpusPath;
    }
    throw new Error(`Coordinator returned ${response.status} for dataset '${domain}'`);
  }

  // Write new corpus
  const content = await response.text();
  fs.writeFileSync(corpusPath, content, 'utf-8');

  // Persist cache metadata
  const newMeta: { etag?: string; lastModified?: string } = {};
  const newEtag = response.headers.get('etag');
  const newLastModified = response.headers.get('last-modified');
  if (newEtag) newMeta.etag = newEtag;
  if (newLastModified) newMeta.lastModified = newLastModified;
  fs.writeFileSync(metaPath, JSON.stringify(newMeta), 'utf-8');

  logger.log(`[Dataset] '${domain}' corpus downloaded → ${corpusPath} (${content.length} chars)`);
  return corpusPath;
}

/**
 * Execute a TRAINING work order by running train_micro.py
 */
export async function executeTrainingWorkOrder(
  workOrder: WorkOrder,
  coordinatorUrl: string,
  peerId: string,
  capabilities: string[],
  iteration: number,
): Promise<{ result: string; success: boolean }> {
  logger.log(` Executing TRAINING: ${workOrder.title}`);

  let payload: TrainingWorkOrderPayload;
  try {
    payload = JSON.parse(workOrder.description) as TrainingWorkOrderPayload;
  } catch {
    return { result: 'Invalid training payload', success: false };
  }

  // Fetch top experiments for mutation engine
  const topExperiments = await fetchTopExperiments(coordinatorUrl);

  // Propose hyperparams via mutation engine
  let mutation = await proposeMutation(topExperiments, payload.currentBestLoss, capabilities);

  // Override with base config if provided
  if (payload.baseConfig) {
    mutation = {
      ...mutation,
      hyperparams: { ...mutation.hyperparams, ...payload.baseConfig },
    };
  }

  // B4: Download domain-specific dataset from coordinator (with ETag caching)
  let datasetPath = payload.datasetId;
  try {
    datasetPath = await downloadDataset(coordinatorUrl, payload.domain);
    logger.log(` Using domain dataset: ${datasetPath}`);
  } catch (err) {
    logger.warn(` Could not download dataset for '${payload.domain}': ${(err as Error).message}. Falling back to datasetId.`);
  }

  // Run actual training via train_micro.py
  let trainingResult;
  try {
    trainingResult = await trainMicroModel({
      proposal: mutation,
      datasetPath,
      hardware: capabilities.includes('gpu') ? 'gpu' : 'cpu',
      runNumber: iteration,
    });
  } catch (err) {
    logger.error(' Training failed:', (err as Error).message);
    return { result: `Training failed: ${(err as Error).message}`, success: false };
  }

  const improved = trainingResult.valLoss < payload.currentBestLoss;

  // A7: Submit results to both endpoints
  await submitTrainingExperiment(
    coordinatorUrl,
    peerId,
    mutation.hyperparams,
    trainingResult.valLoss,
    trainingResult.durationMs,
  );

  await submitTrainingToExperiments(
    coordinatorUrl,
    peerId,
    payload,
    trainingResult.valLoss,
    trainingResult.finalLoss,
    trainingResult.durationMs,
  );

  const result = JSON.stringify({
    valLoss: trainingResult.valLoss,
    finalLoss: trainingResult.finalLoss,
    config: trainingResult.config,
    durationMs: trainingResult.durationMs,
    lossCurve: trainingResult.lossCurve,
    hardwareUsed: trainingResult.hardwareUsed,
    improved,
    metricType: 'val_loss',
    metricValue: trainingResult.valLoss,
  });

  logger.log(` Training complete — valLoss=${trainingResult.valLoss.toFixed(4)}, improved=${improved}`);

  return { result, success: true };
}

/**
 * Detect if work order is of type RESEARCH
 * Checks for RESEARCH type or parses description for research payload
 */
export function isResearchWorkOrder(workOrder: WorkOrder): boolean {
  if (workOrder.type === 'RESEARCH') return true;

  // Try to parse description as JSON with research payload
  try {
    const payload = JSON.parse(workOrder.description);
    return !!(payload.title && payload.abstract);
  } catch {
    return false;
  }
}

/**
 * Extract research payload from work order description
 */
export function extractResearchPayload(workOrder: WorkOrder): ResearchPayload | null {
  try {
    const payload = JSON.parse(workOrder.description);
    if (payload.title && payload.abstract) {
      return {
        title: payload.title,
        abstract: payload.abstract,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build research prompt for LLM
 */
export function buildResearchPrompt(payload: ResearchPayload): string {
  return `You are an expert research analyst in a decentralized AI compute network. Your job is NOT to summarize the paper — it is to critically analyze it and generate original insights.

Read the paper carefully and produce a rigorous analysis. Your entire response must be a single JSON object starting with { and ending with }. Do not include any other text, backticks, or formatting.

Required fields:
- summary: 3-4 sentences covering (1) the core problem the paper solves, (2) the methodology used, (3) the main result or finding, and (4) its significance. Do NOT simply paraphrase the abstract.
- keyInsights: array of exactly 5 strings. Each insight must be a NON-OBVIOUS finding that required reading the paper to discover. Avoid restating the abstract. Focus on: unexpected results, limitations the authors acknowledge, comparisons to prior work, technical tradeoffs, and open questions left unsolved.
- proposal: a concrete, specific application proposal for decentralized compute networks. Must include: (1) which specific technical mechanism from the paper to adopt, (2) how it would be implemented in a peer-to-peer context, (3) expected challenges, and (4) measurable success criteria.

Critical evaluation standards:
- If the paper makes extraordinary claims, note what evidence supports them and what is missing
- Identify the weakest assumption in the methodology
- Flag any reproducibility concerns (missing code, proprietary data, etc.)

Output format (replace values):
{"summary":"...","keyInsights":["...","...","...","...","..."],"proposal":"..."}

Title: ${payload.title}
Abstract: ${payload.abstract}`;
}

/**
 * Execute research work order
 */
export async function fetchHyperparamConfig(coordinatorUrl: string): Promise<{
  config: { id: string; temperature: number; promptTemplate: string; analysisDepth: string; chunkSize?: number };
  strategy: 'exploit' | 'explore';
} | null> {
  try {
    const res = await fetch(`${coordinatorUrl}/hyperparams/suggest`);
    if (!res.ok) return null;
    return await res.json() as any;
  } catch {
    return null;
  }
}

export async function reportHyperparamExperiment(
  coordinatorUrl: string,
  peerId: string,
  config: { id: string; temperature: number; promptTemplate: string; analysisDepth: string; chunkSize?: number },
  qualityScore: number,
  latencyMs: number
): Promise<void> {
  try {
    await fetch(`${coordinatorUrl}/hyperparams/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerId,
        config: { ...config, chunkSize: config.chunkSize ?? 512 },
        qualityScore,
        latencyMs,
        tokenCost: 0,
        papersTested: 1,
      }),
    });
  } catch {
    // Non-critical — don't fail the research
  }
}

export async function executeResearchWorkOrder(
  workOrder: WorkOrder,
  llmModel: LLMModel,
  llmConfig?: LLMConfig,
  coordinatorUrl?: string,
  peerId?: string
): Promise<{ result: ResearchResult; rawResponse: string; success: boolean; hyperparams?: Record<string, unknown> }> {
  logger.log(` Executing research: ${workOrder.title}`);

  const payload = extractResearchPayload(workOrder);
  if (!payload) {
    throw new Error('Invalid research payload in work order');
  }

  // Fetch hyperparameter config from coordinator (exploit best or explore new)
  let hyperConfig: { id: string; temperature: number; promptTemplate: string; analysisDepth: string; chunkSize?: number } | null = null;
  let strategy: 'exploit' | 'explore' = 'explore';
  if (coordinatorUrl) {
    const suggestion = await fetchHyperparamConfig(coordinatorUrl);
    if (suggestion) {
      hyperConfig = suggestion.config;
      strategy = suggestion.strategy;
      logger.log(` Hyperparam config [${strategy}]: temp=${hyperConfig.temperature}, depth=${hyperConfig.analysisDepth}`);
    }
  }

  const prompt = buildResearchPrompt(payload);
  const startMs = Date.now();
  const rawResponse = await generateLLM(llmModel, prompt, llmConfig, hyperConfig ? {
    temperature: hyperConfig.temperature,
  } : undefined);
  const latencyMs = Date.now() - startMs;

  // Parse JSON response
  try {
    // Try to extract JSON from response (LLM may wrap it in markdown code fences
    // or prepend <think>...</think> reasoning blocks)
    // 1. Strip <think>...</think> blocks (reasoning models like DeepSeek, Kimi)
    // 2. Strip ```json ... ``` or ``` ... ``` blocks
    // 3. Fall back to first {...} match
    let jsonStr = rawResponse
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();
    // Handle truncated responses (maxTokens cutoff may remove closing fence)
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                       jsonStr.match(/```(?:json)?\s*([\s\S]*)/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    // Always try to extract first complete {...} block (handles truncation)
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    jsonStr = jsonMatch ? jsonMatch[0] : jsonStr;
    const result = JSON.parse(jsonStr) as ResearchResult;

    // Validate required fields
    if (!result.summary || !Array.isArray(result.keyInsights) || !result.proposal) {
      throw new Error('Invalid research result structure');
    }

    logger.log(` Research complete, summary: ${result.summary.slice(0, 100)}...`);

    // Report hyperparam experiment quality to coordinator
    if (hyperConfig && coordinatorUrl && peerId) {
      const qualityScore = Math.min(10, Math.max(0,
        (result.keyInsights.length >= 3 ? 3 : result.keyInsights.length) +
        (result.summary.length > 200 ? 3 : 1) +
        (result.proposal.length > 100 ? 3 : 1)
      ));
      await reportHyperparamExperiment(coordinatorUrl, peerId, hyperConfig, qualityScore, latencyMs);
      logger.log(` Reported experiment quality: ${qualityScore}/10 (strategy: ${strategy})`);
    }

    return { result, rawResponse, success: true, hyperparams: hyperConfig ?? undefined };
  } catch (error) {
    logger.error(' Failed to parse research result:', (error as Error).message);
    return {
      result: {
        summary: 'Failed to parse LLM response',
        keyInsights: [],
        proposal: rawResponse.slice(0, 500),
      },
      rawResponse,
      success: false,
      hyperparams: hyperConfig ?? undefined,
    };
  }
}

/**
 * Submit research result to coordinator
 */
export async function submitResearchResult(
  coordinatorUrl: string,
  workOrderId: string,
  peerId: string,
  result: ResearchResult,
  hyperparams?: Record<string, unknown>
): Promise<boolean> {
  try {
    const response = await fetch(`${coordinatorUrl}/research-queue/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paperId: workOrderId,
        peerId,
        summary: result.summary,
        keyInsights: result.keyInsights,
        applicationProposal: result.proposal,
        ...(hyperparams ? { hyperparams } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn(` Failed to submit research result:`, error);
      return false;
    }

    logger.log(` Research result submitted successfully`);
    return true;
  } catch (error) {
    logger.warn(' Failed to submit research result:', (error as Error).message);
    return false;
  }
}

/**
 * Save research result to agent brain journal
 */
export function saveResearchToBrain(
  brain: AgentBrain,
  workOrder: WorkOrder,
  result: ResearchResult
): void {
  const journalEntry = {
    timestamp: Date.now(),
    action: `research:${workOrder.id}`,
    outcome: 'completed',
    lesson: `Paper: ${workOrder.title}\nSummary: ${result.summary.slice(0, 200)}\nProposal: ${result.proposal.slice(0, 200)}`,
  };
  brain.journal.push(journalEntry);

  // Add to memory as discovery
  const memoryEntry = {
    timestamp: Date.now(),
    type: 'discovery' as const,
    content: `Research: ${result.summary}`,
    importance: 0.7,
  };
  brain.memory.push(memoryEntry);

  // Prune if needed
  if (brain.journal.length > 100) {
    brain.journal = brain.journal.slice(-100);
  }
  if (brain.memory.length > 100) {
    brain.memory = brain.memory.slice(-100);
  }
}

// ---------------------------------------------------------------------------
// SYN price resolution
// ---------------------------------------------------------------------------

/** Cached SYN price and timestamp (5 min TTL) */
let _synPriceCache: { price: number; fetchedAt: number } | null = null;
const SYN_PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch SYN/USD price from DexScreener (mainnet only).
 * Falls back to DEVNET default (0.01 USD) on any error or when
 * NODE_ENV !== 'production'.
 *
 * Contract env var: SYN_TOKEN_ADDRESS (Solana mint address)
 */
export async function fetchSynPriceUsd(): Promise<number> {
  const DEVNET_PRICE = 0.01; // 1 SYN = $0.01 on devnet

  // Force devnet price in non-production environments
  if (process.env.NODE_ENV !== 'production') {
    return DEVNET_PRICE;
  }

  // Return cached price if still fresh
  if (_synPriceCache && Date.now() - _synPriceCache.fetchedAt < SYN_PRICE_CACHE_TTL_MS) {
    return _synPriceCache.price;
  }

  const tokenAddress = process.env.SYN_TOKEN_ADDRESS;
  if (!tokenAddress) {
    logger.warn('[SynPrice] SYN_TOKEN_ADDRESS not set — using fallback price $0.01');
    return DEVNET_PRICE;
  }

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);

    const data = await response.json() as {
      pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }>;
    };

    // Pick the pair with highest liquidity
    const pairs = (data.pairs ?? []).filter(p => p.priceUsd);
    if (pairs.length === 0) throw new Error('No pairs returned');
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = parseFloat(pairs[0].priceUsd!);
    if (isNaN(price) || price <= 0) throw new Error('Invalid price from DexScreener');

    _synPriceCache = { price, fetchedAt: Date.now() };
    logger.log(`[SynPrice] Fetched SYN price from DexScreener: $${price}`);
    return price;
  } catch (err) {
    logger.warn(`[SynPrice] DexScreener fetch failed: ${(err as Error).message} — using fallback $0.01`);
    return DEVNET_PRICE;
  }
}

/**
 * Load economic configuration from environment or defaults
 * 
 * Priority for LLM cost:
 * 1. LLM_COST_PER_1K_TOKENS env var (manual override)
 * 2. Price table lookup by LLM_MODEL
 * 3. Default fallback (claude-haiku pricing)
 * 
 * @param runtimeModel - The actual model being used (from CLI config), takes
 *   precedence over the LLM_MODEL env var so cloud models are detected correctly.
 */
export function loadEconomicConfig(runtimeModel?: string): EconomicConfig {
  // runtimeModel (from CLI) wins over env var so cloud models aren't mistaken for ollama
  const llmModel = runtimeModel ?? process.env.LLM_MODEL ?? 'ollama/phi4-mini';

  // Derive llmType from the resolved model name rather than trusting a separate env var.
  // A model is considered local (ollama) only when it explicitly has the ollama/ prefix.
  // Everything else (gpt-*, claude-*, openai-compat/*, anthropic/*, etc.) is cloud.
  const isOllamaModel = llmModel.startsWith('ollama/');
  const llmType: 'ollama' | 'cloud' = isOllamaModel ? 'ollama' : 'cloud';
  
  // Get cost from price table or fallback
  let llmCostPer1kTokens: number;
  
  if (process.env.LLM_COST_PER_1K_TOKENS) {
    // Manual override takes priority
    llmCostPer1kTokens = parseFloat(process.env.LLM_COST_PER_1K_TOKENS);
  } else if (llmType === 'ollama') {
    // Ollama local models are always $0
    llmCostPer1kTokens = 0;
  } else {
    // Look up in price table with fallback
    llmCostPer1kTokens = getModelCostPer1kTokens(llmModel);
  }

  // SYN price: use env override, else devnet default (0.01 USD).
  // On mainnet, callers should use loadEconomicConfigAsync() to get the live price.
  const synPriceUsd = parseFloat(process.env.SYN_PRICE_USD ?? '0.01');

  return {
    synPriceUsd,
    llmType,
    llmModel,
    llmCostPer1kTokens,
    minProfitRatio: parseFloat(process.env.MIN_PROFIT_RATIO ?? '1.5'),
  };
}

/**
 * Async version of loadEconomicConfig that fetches SYN price dynamically.
 * - DEVNET / non-production: always returns 0.01 USD
 * - MAINNET: fetches from DexScreener (cached 5 min), falls back to 0.01 USD
 */
export async function loadEconomicConfigAsync(runtimeModel?: string): Promise<EconomicConfig> {
  const base = loadEconomicConfig(runtimeModel);
  // Only override synPriceUsd if not set via env
  if (!process.env.SYN_PRICE_USD) {
    base.synPriceUsd = await fetchSynPriceUsd();
  }
  return base;
}

/**
 * Estimate LLM cost based on input text length
 * 
 * Rough estimation:
 * - Input tokens ≈ text.length / 4 (1 token ≈ 4 chars)
 * - Output tokens ≈ 500 (fixed for research responses)
 * 
 * Ollama (local) has $0 cost
 * Cloud models use configured price per 1K tokens
 */
export function estimateLLMCost(
  abstract: string,
  config: EconomicConfig
): number {
  // Ollama local models have no API cost
  if (config.llmType === 'ollama') {
    return 0;
  }

  // Estimate tokens (rough approximation)
  const inputTokens = Math.ceil(abstract.length / 4);
  const outputTokens = 500; // Fixed estimate for research responses
  const totalTokens = inputTokens + outputTokens;

  // Calculate cost
  const cost = (totalTokens / 1000) * config.llmCostPer1kTokens;
  return cost;
}

/**
 * Evaluate if a work order is economically viable
 * 
 * For RESEARCH work orders:
 * 1. Calculate bounty in USD (bountySyn * synPriceUsd)
 * 2. Estimate LLM cost based on abstract length
 * 3. If ratio < minProfitRatio → reject
 * 4. If llmType=ollama → always accept (cost is $0)
 * 
 * For other work orders → always accept (no compute cost tracked yet)
 */
export function evaluateWorkOrder(
  workOrder: WorkOrder,
  config: EconomicConfig
): WorkOrderEvaluation {
  const bountySyn = parseSynToLamports(workOrder.rewardAmount);
  // bountySyn is in lamports (1e9 per SYN) — convert to SYN before USD calc
  const bountyUsd = (Number(bountySyn) / 1e9) * config.synPriceUsd;

  // Non-research work orders: always accept (no compute cost tracking yet)
  if (!isResearchWorkOrder(workOrder)) {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: 'Non-research WO: no compute cost estimation needed',
    };
  }

  // Extract abstract for cost estimation
  const payload = extractResearchPayload(workOrder);
  if (!payload) {
    return {
      shouldAccept: false,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: 0,
      reason: 'Invalid research payload',
    };
  }

  // Calculate cost
  const estimatedCostUsd = estimateLLMCost(payload.abstract, config);

  // Ollama (local) always accepts since cost is $0
  if (config.llmType === 'ollama') {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: 'Local Ollama model: zero API cost, always accept',
    };
  }

  // Cloud models: check profit ratio
  if (estimatedCostUsd === 0) {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: 'Zero cost estimate, accepting',
    };
  }

  const profitRatio = bountyUsd / estimatedCostUsd;
  const shouldAccept = profitRatio >= config.minProfitRatio;

  return {
    shouldAccept,
    bountySyn,
    bountyUsd,
    estimatedCostUsd,
    profitRatio,
    reason: shouldAccept
      ? `Profitable: ratio ${profitRatio.toFixed(2)}x >= ${config.minProfitRatio}x minimum`
      : `Not profitable: ratio ${profitRatio.toFixed(2)}x < ${config.minProfitRatio}x minimum`,
  };
}

/**
 * Execute a work order using LLM
 */
export async function executeWorkOrder(
  workOrder: WorkOrder,
  llmModel: LLMModel,
  llmConfig?: LLMConfig
): Promise<{ result: string; success: boolean }> {
  logger.log(` Executing: ${workOrder.title}`);

  try {
    // Check if this is a research work order
    if (isResearchWorkOrder(workOrder)) {
      const { result, rawResponse, success } = await executeResearchWorkOrder(
        workOrder,
        llmModel,
        llmConfig
      );
      return { result: rawResponse, success };
    }

    // Standard work order execution (TRAINING, INFERENCE, etc.)
    const prompt = buildWorkOrderPrompt(workOrder);
    const result = await generateLLM(llmModel, prompt, llmConfig);

    logger.log(` Execution complete, result length: ${result.length} chars`);

    return { result, success: true };
  } catch (error) {
    logger.error(' Execution failed:', (error as Error).message);
    return {
      result: `Error: ${(error as Error).message}`,
      success: false
    };
  }
}

/**
 * Build prompt for work order execution
 */
function buildWorkOrderPrompt(workOrder: WorkOrder): string {
  return `You are a SynapseIA network node executing a work order.

Task: ${workOrder.title}
Description: ${workOrder.description}

Please provide a detailed response to complete this task. Be thorough and accurate.

Response:`;
}

/**
 * Run single iteration of the work order agent
 */
export async function runWorkOrderAgentIteration(
  config: WorkOrderAgentConfig,
  iteration: number,
  brain?: AgentBrain
): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
  const { coordinatorUrl, peerId, capabilities, llmModel, llmConfig } = config;

  logger.log(`..............................`);
  logger.log(`Iteration ${iteration} starting...`);

  // 1. Fetch available work orders
  logger.log(' Polling for available work orders...');
  const workOrders = await fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);

  if (workOrders.length === 0) {
    logger.log(' No work orders available');
    return { completed: false };
  }

  logger.log(` Found ${workOrders.length} available work order(s)`);

  // Filter work orders:
  // - Non-research: skip permanently once completed this session
  // - Research: skip only during cooldown period (allows re-analysis with different hyperparams)
  const now = Date.now();
  const pendingWorkOrders = workOrders.filter(wo => {
    if (isResearchWorkOrder(wo)) {
      const cooldownUntil = agentState.researchCooldowns.get(wo.id);
      if (cooldownUntil && now < cooldownUntil) {
        const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
        logger.log(` Research WO "${wo.title}" on cooldown — ${remainingSec}s remaining`);
        return false;
      }
      return true; // Ready to re-analyze with new hyperparams
    }
    return !agentState.completedWorkOrderIds.has(wo.id);
  });
  if (pendingWorkOrders.length < workOrders.length) {
    logger.log(` Skipping ${workOrders.length - pendingWorkOrders.length} WO(s) (completed/cooldown) — ${pendingWorkOrders.length} remaining`);
  }
  if (pendingWorkOrders.length === 0) {
    logger.log(' All work orders completed or on cooldown — waiting');
    return { completed: false };
  }

  // Try each work order until one is successfully accepted
  for (const workOrder of pendingWorkOrders) {
    logger.log(` Selected: "${workOrder.title}" (reward: ${workOrder.rewardAmount} SYN)`);

    // Evaluate economic viability (rational node behavior)
    const economicConfig = loadEconomicConfig(config.llmModel?.modelId);
    const evaluation = evaluateWorkOrder(workOrder, economicConfig);

    logger.log(` Economic evaluation:`);
    logger.log(`  - Bounty: ${evaluation.bountyUsd.toFixed(4)} USD (${workOrder.rewardAmount} SYN)`);
    logger.log(`  - Est. cost: ${evaluation.estimatedCostUsd.toFixed(4)} USD`);
    logger.log(`  - Profit ratio: ${evaluation.profitRatio === Infinity ? '∞' : evaluation.profitRatio.toFixed(2) + 'x'}`);
    logger.log(`  - Decision: ${evaluation.shouldAccept ? 'ACCEPT' : 'SKIP'} (${evaluation.reason})`);

    if (!evaluation.shouldAccept) {
      logger.log(' Skipping work order due to poor economics');
      continue; // Try next work order
    }

    // Try to accept work order
    logger.log(' Accepting work order...');
    const accepted = await acceptWorkOrder(coordinatorUrl, workOrder.id, peerId, capabilities);

    if (!accepted) {
      logger.log(' Failed to accept work order (likely race condition), trying next...');
      continue; // Try next work order
    }

    logger.log(' Work order accepted');
    agentState.currentWorkOrder = workOrder;

  // 4. Execute work order (handle RESEARCH specially)
  logger.log(' Executing work order...');

  let result: string;
  let success: boolean;
  let researchResult: ResearchResult | undefined;

  if (isTrainingWorkOrder(workOrder)) {
    // Execute TRAINING work order (runs train_micro.py)
    const training = await executeTrainingWorkOrder(
      workOrder,
      coordinatorUrl,
      peerId,
      capabilities,
      iteration,
    );
    result = training.result;
    success = training.success;
  } else if (isResearchWorkOrder(workOrder)) {
    // Execute research work order
    const research = await executeResearchWorkOrder(workOrder, llmModel, llmConfig, coordinatorUrl, peerId);
    // Use the parsed result as the submitted result (not the raw LLM response with <think> blocks)
    result = JSON.stringify({
      summary: research.result.summary,
      keyInsights: research.result.keyInsights,
      proposal: research.result.proposal,
      hypothesis: research.result.summary,
      metricType: 'coherence',
      metricValue: research.success ? scoreResearchResult(research.result) : 0.0,
      proof: research.result.proposal,
    });
    success = research.success;
    researchResult = research.result;
    const researchHyperparams = research.hyperparams;

    // Save to agent brain if provided
    if (brain && success) {
      saveResearchToBrain(brain, workOrder, researchResult);
      logger.log(' Research saved to agent brain');
    }

    // Submit to research queue endpoint
    if (success) {
      // Find paperId from research queue by title (workaround for missing paperId in metadata)
      let paperId = workOrder.id.replace(/^wo_/, 'paper_'); // fallback
      
      const tryPaperId = async (paperTitleFragment: string): Promise<string | null> => {
        try {
          const resp = await fetch(`${coordinatorUrl}/research-queue/papers`);
          if (!resp.ok) return null;
          const data = await resp.json() as { papers?: Array<{id: string, title: string}> };
          if (!data.papers) return null;
          const match = data.papers.find(p => p.title === paperTitleFragment || 
            p.title === workOrder.title ||
            (p.title.includes(workOrder.title.substring(0, 40))));
          if (match) return match.id;
        } catch (e) {
          logger.warn(' Failed to lookup paperId:', e);
        }
        return null;
      };

      const foundPaperId = await tryPaperId(workOrder.title);
      if (foundPaperId) {
        paperId = foundPaperId;
      }

      const submitted = await submitResearchResult(
        coordinatorUrl,
        paperId,
        peerId,
        researchResult,
        researchHyperparams
      );
      if (submitted) {
        logger.log(' Research result submitted to research queue');
      }
    }
  } else {
    // Standard work order execution (TRAINING, INFERENCE, etc.)
    const execution = await executeWorkOrder(workOrder, llmModel, llmConfig);
    result = execution.result;
    success = execution.success;
  }

  // 5. Complete work order — skip if research or training failed
  if ((isResearchWorkOrder(workOrder) || isTrainingWorkOrder(workOrder)) && !success) {
    logger.warn(' Work order execution failed — skipping result submission to avoid polluting rewards');
    agentState.currentWorkOrder = undefined;
    continue;
  }

  logger.log(' Reporting result...');
  const completed = await completeWorkOrder(
    coordinatorUrl,
    workOrder.id,
    peerId,
    result,
    success
  );

  if (completed) {
    logger.log(` Result submitted for round evaluation! Potential reward: ${workOrder.rewardAmount} SYN (paid when round closes)`);
    logger.log(` Waiting for round to close to determine final reward...`);
    agentState.totalWorkOrdersCompleted++;
    if (isResearchWorkOrder(workOrder)) {
      // Research papers can be re-analyzed after cooldown (different hyperparams = more diversity)
      agentState.researchCooldowns.set(workOrder.id, Date.now() + RESEARCH_COOLDOWN_MS);
      logger.log(` Research paper will be available for re-analysis in ${RESEARCH_COOLDOWN_MS / 1000}s`);
    } else {
      agentState.completedWorkOrderIds.add(workOrder.id);
    }
  } else {
    logger.log(' Failed to report completion');
  }

    agentState.iteration = iteration;
    return { workOrder, completed, researchResult };
  } // End of for loop - tried all work orders

  // If we get here, no work order could be accepted
  logger.log(' Could not accept any work order (all failed or skipped)');
  agentState.iteration = iteration;
  return { completed: false };
}

/**
 * Start the work order agent loop
 */
export async function startWorkOrderAgent(config: WorkOrderAgentConfig): Promise<void> {
  if (agentState.isRunning) {
    throw new Error('Work order agent is already running');
  }

  agentState.isRunning = true;
  const { intervalMs, maxIterations } = config;

  // Connect to coordinator WebSocket to receive round.closed notifications
  const peerId = config.peerId ?? 'unknown';
  startRoundListener(config.coordinatorUrl, peerId);

  // Startup summary is logged by the caller (node-runtime / CLI)

  try {
    let iteration = 1;

    /* istanbul ignore next - async loop control, not business logic */
    while (shouldContinueLoop(agentState.isRunning, iteration, maxIterations)) {
      try {
        await runWorkOrderAgentIteration(config, iteration);
      } catch (error) {
        logger.error(` Iteration ${iteration} failed:`, (error as Error).message);
      }

      // Sleep before next iteration
      if (shouldSleepBetweenIterations(agentState.isRunning)) {
        logger.log(` Sleeping for ${intervalMs}ms...`);
        /* istanbul ignore next - async loop control, not business logic */
        await sleep(intervalMs);
      }

      iteration++;
    }

    if (maxIterations && iteration > maxIterations) {
      logger.log(`\n Reached max iterations (${maxIterations}), stopping.`);
    }
  } finally {
    agentState.isRunning = false;
    logger.log('\n Stopped');
  }
}

/**
 * Stop the work order agent
 */
export function stopWorkOrderAgent(): void {
  agentState.isRunning = false;
  logger.log(' Stopping...');
}

/**
 * Check if the agent should stop due to reaching max iterations
 * Pure function for testability
 */
export function shouldStopForMaxIterations(
  iteration: number,
  maxIterations?: number,
): boolean {
  if (!maxIterations) return false;
  return iteration > maxIterations;
}

/**
 * Check if the loop should continue
 * Pure function for testability
 */
export function shouldContinueLoop(
  isRunning: boolean,
  iteration: number,
  maxIterations?: number,
): boolean {
  if (!isRunning) return false;
  if (maxIterations && iteration > maxIterations) return false;
  return true;
}

/**
 * Check if the agent should sleep between iterations
 * Pure function for testability
 */
export function shouldSleepBetweenIterations(isRunning: boolean): boolean {
  return isRunning;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Export for testing
export const _test = {
  fetchAvailableWorkOrders,
  acceptWorkOrder,
  completeWorkOrder,
  executeWorkOrder,
  runWorkOrderAgentIteration,
  sleep,
  shouldStopForMaxIterations,
  shouldContinueLoop,
  shouldSleepBetweenIterations,
  isResearchWorkOrder,
  isTrainingWorkOrder,
  extractResearchPayload,
  buildResearchPrompt,
  executeResearchWorkOrder,
  executeTrainingWorkOrder,
  fetchTopExperiments,
  submitTrainingExperiment,
  submitTrainingToExperiments,
  submitResearchResult,
  saveResearchToBrain,
  loadEconomicConfig,
  estimateLLMCost,
  evaluateWorkOrder,
  getModelCostPer1kTokens,
  downloadDataset,
  getDatasetCacheDir,
};

// ---------------------------------------------------------------------------
// Injectable helper class — wraps the standalone functions for NestJS DI
// ---------------------------------------------------------------------------

@Injectable()
export class WorkOrderAgentHelper {
  startWorkOrderAgent(config: WorkOrderAgentConfig): Promise<void> {
    return startWorkOrderAgent(config);
  }

  stopWorkOrderAgent(): void {
    return stopWorkOrderAgent();
  }

  getWorkOrderAgentState(): WorkOrderAgentState {
    return getWorkOrderAgentState();
  }

  resetWorkOrderAgentState(): void {
    return resetWorkOrderAgentState();
  }

  runWorkOrderAgentIteration(
    config: WorkOrderAgentConfig,
    iteration: number,
    brain?: AgentBrain,
  ): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
    return runWorkOrderAgentIteration(config, iteration, brain);
  }

  fetchAvailableWorkOrders(
    coordinatorUrl: string,
    peerId: string,
    capabilities: string[],
  ): Promise<WorkOrder[]> {
    return fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
  }

  acceptWorkOrder(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    nodeCapabilities?: string[],
  ): Promise<boolean> {
    return acceptWorkOrder(coordinatorUrl, workOrderId, peerId, nodeCapabilities);
  }

  completeWorkOrder(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: string,
    success?: boolean,
  ): Promise<boolean> {
    return completeWorkOrder(coordinatorUrl, workOrderId, peerId, result, success);
  }

  executeWorkOrder(
    workOrder: WorkOrder,
    llmModel: LLMModel,
    llmConfig?: LLMConfig,
  ): Promise<{ result: string; success: boolean }> {
    return executeWorkOrder(workOrder, llmModel, llmConfig);
  }

  executeResearchWorkOrder(
    workOrder: WorkOrder,
    llmModel: LLMModel,
    llmConfig?: LLMConfig,
  ): Promise<{ result: ResearchResult; rawResponse: string; success: boolean }> {
    return executeResearchWorkOrder(workOrder, llmModel, llmConfig);
  }

  submitResearchResult(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: ResearchResult,
  ): Promise<boolean> {
    return submitResearchResult(coordinatorUrl, workOrderId, peerId, result);
  }

  isResearchWorkOrder(workOrder: WorkOrder): boolean {
    return isResearchWorkOrder(workOrder);
  }

  extractResearchPayload(workOrder: WorkOrder): ResearchPayload | null {
    return extractResearchPayload(workOrder);
  }

  buildResearchPrompt(payload: ResearchPayload): string {
    return buildResearchPrompt(payload);
  }

  saveResearchToBrain(brain: AgentBrain, workOrder: WorkOrder, result: ResearchResult): void {
    return saveResearchToBrain(brain, workOrder, result);
  }

  evaluateWorkOrder(workOrder: WorkOrder, config: EconomicConfig): WorkOrderEvaluation {
    return evaluateWorkOrder(workOrder, config);
  }

  loadEconomicConfig(runtimeModel?: string): EconomicConfig {
    return loadEconomicConfig(runtimeModel);
  }

  estimateLLMCost(abstract: string, config: EconomicConfig): number {
    return estimateLLMCost(abstract, config);
  }

  getModelCostPer1kTokens(model: string): number {
    return getModelCostPer1kTokens(model);
  }

  shouldContinueLoop(isRunning: boolean, iteration: number, maxIterations?: number): boolean {
    return shouldContinueLoop(isRunning, iteration, maxIterations);
  }

  shouldStopForMaxIterations(iteration: number, maxIterations?: number): boolean {
    return shouldStopForMaxIterations(iteration, maxIterations);
  }

  shouldSleepBetweenIterations(isRunning: boolean): boolean {
    return shouldSleepBetweenIterations(isRunning);
  }

  downloadDataset(coordinatorUrl: string, domain: string): Promise<string> {
    return downloadDataset(coordinatorUrl, domain);
  }

  getDatasetCacheDir(): string {
    return getDatasetCacheDir();
  }
}
