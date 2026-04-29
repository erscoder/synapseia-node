/**
 * Node-side mirror of the coordinator's LoRA types. The shapes MUST
 * stay in sync with `packages/coordinator/src/domain/entities/LoraAdapter.ts`
 * + `application/lora/LoraSubmissionService.ts` — the submission this
 * node returns is wire-validated on the other side.
 */

export type LoraSubtype = 'LORA_CLASSIFICATION' | 'LORA_GENERATION';
export type LoraBaseModel = 'PubMedBERT' | 'BioGPT-Large';

export interface LoraConfig {
  readonly r: number;
  readonly alpha: number;
  readonly dropout: number;
  readonly target_modules: readonly string[];
}

/** Coordinator-issued WO payload (sent in workOrder.description). */
export interface LoraWorkOrderPayload {
  readonly adapterId: string;
  readonly missionId: string;
  readonly subtype: LoraSubtype;
  readonly baseModel: LoraBaseModel;
  readonly trainingDatasetUri: string;
  readonly validationDatasetUri: string;
  readonly loraConfig: LoraConfig;
  readonly maxEpochs: number;
  readonly earlyStopPatience: number;
  readonly seed: number;
  /** Pre-signed S3 PUT URL the trainer streams adapter_model.safetensors to. */
  readonly uploadUrl: string;
}

export interface LoraValMetrics {
  accuracy?: number;
  f1?: number;
  perplexity?: number;
}

/** Submission shape returned to the coordinator. */
export interface LoraSubmissionPayload {
  readonly adapterId: string;
  readonly artifactUri: string;
  readonly artifactSha256: string;
  readonly reportedValMetrics: LoraValMetrics;
  readonly trainerWallet?: string;
  readonly trainerPeerId?: string;
}
