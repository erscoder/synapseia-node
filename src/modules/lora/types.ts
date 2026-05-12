/**
 * Node-side mirror of the coordinator's LoRA types. The shapes MUST
 * stay in sync with:
 *   - `packages/coordinator/src/domain/entities/LoraAdapter.ts`
 *   - `packages/coordinator/src/application/lora/LoraSubmissionService.ts`
 *   - `packages/coordinator/src/domain/entities/LoraValidationResult.ts` (Phase 1)
 *   - `packages/coordinator/src/application/lora/dto/lora-validation.dto.ts` (Phase 1)
 *
 * The submission shapes this node returns are wire-validated on the
 * coordinator side. Adding/removing fields here without mirroring on the
 * coord DTO will silently drop fields (or, with `forbidNonWhitelisted`,
 * cause Phase 3 ingest to reject).
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

// ── LoRA validator (Plan 1 Phase 2) ─────────────────────────────────────────

/**
 * Coordinator-issued LORA_VALIDATION WO payload (sent in `workOrder.description`).
 *
 * Phase 2 wire shape — the coordinator's Phase 3 producer (not yet wired)
 * emits this. The node refuses to process LORA_VALIDATION WOs unless
 * `LORA_VALIDATOR_ENABLED=true` (set by the `--lora-validator` CLI flag).
 *
 * Stay-in-sync with the coordinator side: any field addition here that
 * the coord emits MUST be added on `LoraValidationWorkOrderPayload` in
 * Phase 3 — otherwise the validator silently ignores it.
 */
export interface LoraValidationWorkOrderPayload {
  readonly adapterId: string;
  readonly adapterUri: string;
  readonly adapterSha256: string; // 'sha256:<hex>' or raw hex
  readonly validationSetUri: string;
  readonly validationSetSha256: string;
  readonly baseModel: LoraBaseModel;
  readonly subtype: LoraSubtype;
  readonly uploadDeadlineMs?: number;
}

/**
 * Submission shape the validator returns. Mirrors
 * `LoraValidationResultDto` (coordinator DTO, Phase 1). The dispatcher
 * JSON-serialises this and the coord's complete-WO path routes it to
 * `LoraVerificationService.ingest` (Phase 3, not yet wired).
 *
 * `signature` is exactly 128 hex chars (64-byte Ed25519). See
 * `lora_validator.ts:canonicalEnvelope` for the canonical message format.
 */
export interface LoraValidationSubmissionPayload {
  readonly adapterId: string;
  readonly workOrderId: string;
  readonly validatorPeerId: string;
  readonly validatorWallet?: string;
  readonly observed: LoraValMetrics;
  readonly signature: string;
}
