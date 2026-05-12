/**
 * Work Order shared types — interfaces, enums, and constants
 * All other work-order/* files import from here.
 */

import type { LLMConfig, LLMModel } from '../../llm/llm-provider';

export interface WorkOrderAgentConfig {
  coordinatorUrl: string;
  /**
   * Optional dedicated WebSocket URL for the coordinator. When the coord
   * is split across HTTP (port 3701) and WS (port 3702) processes, set
   * this to the WS endpoint so Socket.IO connects to the right side and
   * survives an HTTP-process restart. Falls back to `coordinatorUrl` so
   * single-process dev setups keep working unchanged.
   */
  coordinatorWsUrl?: string;
  peerId: string;
  /**
   * Solana wallet base58 address (the node's reward / signing wallet).
   * Coord's WorkOrderCompletionService cross-checks every accept /
   * complete / submit-result body against the wallet on file for the
   * authenticated peer (audit P0 #3); pre-fix the node passed peerId
   * here, which never matched and produced 403 NODE_FORBIDDEN.
   */
  walletAddress: string;
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
  status: 'PENDING' | 'ACCEPTED' | 'COMPLETED' | 'VERIFIED' | 'CANCELLED';
  creatorAddress: string;
  assigneeAddress?: string;
  createdAt: number;
  expiresAt?: number;
  type?: 'TRAINING' | 'RESEARCH' | 'INFERENCE' | 'CPU_INFERENCE' | 'GPU_INFERENCE' | 'DILOCO_TRAINING' | 'MOLECULAR_DOCKING' | 'LORA_TRAINING' | 'LORA_VALIDATION' | 'COMPUTATION' | 'DATA_PROCESSING';
  metadata?: Record<string, string>;
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

export interface WorkOrderAgentState {
  iteration: number;
  totalWorkOrdersCompleted: number;
  totalRewardsEarned: bigint;
  isRunning: boolean;
  currentWorkOrder?: WorkOrder;
  completedWorkOrderIds: Set<string>;
  researchCooldowns: Map<string, number>;
}

export interface EconomicConfig {
  synPriceUsd: number;
  llmType: 'ollama' | 'cloud';
  llmModel: string;
  llmCostPer1kTokens: number;
  minProfitRatio: number;
}

export interface WorkOrderEvaluation {
  shouldAccept: boolean;
  bountySyn: bigint;
  bountyUsd: number;
  estimatedCostUsd: number;
  profitRatio: number;
  reason: string;
}

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

export interface DiLoCoWorkOrderPayload {
  domain: string;
  modelId: string;
  outerRound: number;
  innerSteps: number;
  datasetId: string;
  currentAdapterUrl?: string;
  hyperparams: {
    learningRate?: number;
    batchSize?: number;
  };
  deadline: number;
}

export interface CpuInferenceWorkOrderPayload {
  task: 'embedding' | 'tokenize' | 'classify';
  input: string;
  modelHint?: string;
  domain?: string;
}

export interface CpuInferenceResultPayload {
  output: number[] | string;
  tokensProcessed: number;
  latencyMs: number;
  modelUsed: string;
}

export interface GpuInferenceWorkOrderPayload {
  task: 'generate' | 'summarize' | 'embedding_large';
  input: string;
  modelHint?: string;
  domain?: string;
  maxTokens?: number;
}

export type GpuInferenceResultPayload = CpuInferenceResultPayload;

/** Model used for Ollama embeddings in CPU_INFERENCE work orders */
export const EMBEDDING_MODEL = 'locusai/all-minilm-l6-v2';

/** Default large model for GPU_INFERENCE (requires ≥6GB VRAM) */
export const GPU_INFERENCE_MODEL = 'qwen2.5:7b';
