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
  type?: 'TRAINING' | 'RESEARCH' | 'CPU_INFERENCE' | 'GPU_INFERENCE' | 'DILOCO_TRAINING' | 'DILOCO_AGGREGATION' | 'MOLECULAR_DOCKING' | 'LORA_TRAINING' | 'LORA_VALIDATION';
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
  /**
   * F-node-005 (HIGH): sha256 of the current aggregate adapter at
   * `currentAdapterUrl`. The node MUST refuse to load the adapter when
   * this is missing or doesn't match the downloaded bytes (poisoning /
   * pickle-RCE candidate). Encoded as raw lowercase hex (64 chars), with
   * optional `sha256:` prefix accepted. Coordinator computes it on upload
   * (`packages/coordinator/.../work-order.coordinator.ts` post-upload hash)
   * and MUST populate this field in every DiLoCo WO description.
   *
   * Operator follow-up: coord-side wiring lives in a separate slice (see
   * audit F-node-005). When `currentAdapterUrl` is set but
   * `adapterSha256` is unset, the WO is rejected fail-closed — no
   * silent fallback.
   */
  adapterSha256?: string;
  hyperparams: {
    learningRate?: number;
    batchSize?: number;
  };
  deadline: number;
}

/**
 * DILOCO_AGGREGATION WO payload (node-side aggregation re-architecture,
 * Phase 3). Coord → node contract — MUST match field-for-field the
 * payload the coord builds in
 * `WorkOrderCreationService.createDiLoCoAggregationWorkOrder` (design §3.1).
 * Shipped as JSON in `WorkOrder.description`.
 *
 * Everything here is coord-pinned: the node MUST NOT recompute
 * `stakeWeight` (it has no stake oracle) and MUST use the exact pinned
 * `prevVelocity` / `prevAdapter` S3 keys (NOT node-local velocity — §2
 * velocity carry-over). `s3Key` values are bucket-relative keys in the
 * shared DiLoCo S3 bucket (`AWS_DILOCO_BUCKET`).
 */
export interface DiLoCoAggregationGradient {
  peerId: string;
  walletAddress: string | null;
  /** Bucket-relative S3 key of the peer's pinned gradient (reported in the
   *  result; the node downloads via `downloadUrl`, not this key). */
  s3Key: string;
  /** Hex sha256 (64 chars) the node MUST verify on the downloaded bytes
   *  (P2 fail-closed — abort on mismatch, never aggregate wrong bytes). */
  sha256: string;
  /** Coord-computed sqrt-stake weight — node uses verbatim. */
  stakeWeight: number;
  /** Phase 4: presigned GET URL the node downloads over plain HTTP (no AWS
   *  creds). The node sha256-verifies the bytes against `sha256` above. */
  downloadUrl: string;
}

export interface DiLoCoAggregationWorkOrderPayload {
  roundId: string;
  domain: string;
  outerRound: number;
  modelId: string;
  momentum: number;
  gradients: DiLoCoAggregationGradient[];
  /** Round 0 → null (§2 adapter-accumulation cold-start). `downloadUrl` =
   *  presigned GET; the node sha256-verifies against `sha256`. */
  prevAdapter: { s3Key: string; sha256: string; downloadUrl: string } | null;
  /** Round 0 → null (§2 velocity carry-over cold-start). */
  prevVelocity: { s3Key: string; sha256: string; downloadUrl: string } | null;
  /** Phase 4: presigned PUT URL for THIS aggregator's candidate adapter at
   *  `<domain>/round_<n>/candidates/<thisAggregatorPeerId>/<workOrderId>/adapter_weights.pkl`
   *  (P36 per-peer prefix + attempt-unique `<workOrderId>/` level). The node
   *  uploads over plain HTTP (no AWS creds); the reported `adapterS3Key` =
   *  `adapterS3Key` below so the coord reads it back (it has direct S3) and
   *  verifies sha256. */
  adapterUploadUrl: string;
  /** Presigned PUT URL for THIS aggregator's candidate velocity at
   *  `<domain>/round_<n>/candidates/<thisAggregatorPeerId>/<workOrderId>/velocity.pkl`. */
  velocityUploadUrl: string;
  /** Coord-determined attempt-unique candidate keys behind the PUT URLs
   *  above. The node reports these VERBATIM (it does NOT rebuild the key) so
   *  the reveal's key is always the exact immutable object the presigned URL
   *  targets — a later redispatch (different WO id → different key) can never
   *  overwrite the bytes this reveal points to. Optional for backwards-compat
   *  with an old coord that ships only the URLs (the runner falls back to
   *  rebuilding the round-level key in that case). */
  adapterS3Key?: string;
  velocityS3Key?: string;
  /** Canonical cosine-reject threshold, coord-pinned. */
  cosineRejectThreshold: number;
  /** Coord-computed quorum; echoed back in the result, coord re-checks. */
  effectiveQuorum: number;
  /** Aggregation WO deadline (unix ms). */
  deadlineMs: number;
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
