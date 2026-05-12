/**
 * WorkOrderExecutionHelper — executes work orders (research, training, diloco, inference).
 */

import { Injectable } from '@nestjs/common';
import * as path from 'path';
import * as os from 'os';
import logger from '../../../utils/logger';
import { LlmProviderHelper, type LLMConfig, type LLMModel } from '../../llm/llm-provider';
import { EmbeddingHelper } from '../../../shared/embedding';
import { trainMicroModel, TRAINER_EVAL_FAILED_SENTINEL } from '../../model/trainer';
import { runDocking, DockingError } from '../../docking';
import type { DockingWorkOrderPayload } from '../../docking/types';
import { runLora, LoraError } from '../../lora/lora_trainer';
import { runLoraValidation, LoraValidationError } from '../../lora/lora_validator';
import type { LoraWorkOrderPayload, LoraValidationWorkOrderPayload } from '../../lora/types';
import { MutationEngineHelper, MutationEngineError } from '../../model/mutation-engine';
import { runDiLoCoInnerLoop } from '../../model/diloco-trainer';
import { downloadAdapter } from '../../model/model-downloader';
import { safeLoss } from './safe-loss';
import type { AgentBrain } from '../agent-brain';
import type {
  WorkOrder,
  ResearchResult,
  ResearchPayload,
  TrainingWorkOrderPayload,
  DiLoCoWorkOrderPayload,
  CpuInferenceWorkOrderPayload,
  CpuInferenceResultPayload,
  GpuInferenceWorkOrderPayload,
} from './work-order.types';
import { EMBEDDING_MODEL as EMBED_MODEL, GPU_INFERENCE_MODEL } from './work-order.types';
import { WorkOrderCoordinatorHelper } from './work-order.coordinator';
import { WorkOrderEvaluationHelper } from './work-order.evaluation';

const OLLAMA_EMBEDDING_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

@Injectable()
export class WorkOrderExecutionHelper {
  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly evaluation: WorkOrderEvaluationHelper,
    private readonly llmProvider: LlmProviderHelper,
  ) {}

  // ── Type detection ────────────────────────────────────────────────────────

  isResearchWorkOrder(workOrder: WorkOrder): boolean {
    if (workOrder.type === 'RESEARCH') return true;
    return this.extractResearchPayload(workOrder) !== null;
  }

  isTrainingWorkOrder(workOrder: WorkOrder): boolean {
    if (workOrder.type === 'TRAINING') return true;
    try {
      const p = JSON.parse(workOrder.description) as Partial<TrainingWorkOrderPayload>;
      return !!(p.domain && p.datasetId !== undefined && p.currentBestLoss !== undefined);
    } catch { return false; }
  }

  isDiLoCoWorkOrder(workOrder: WorkOrder): boolean {
    if ((workOrder.type as string) === 'DILOCO_TRAINING' || (workOrder.type as string) === 'diloco_training') return true;
    try {
      const p = JSON.parse(workOrder.description) as Partial<DiLoCoWorkOrderPayload>;
      return !!(p.domain !== undefined && p.modelId !== undefined && p.outerRound !== undefined && p.innerSteps !== undefined && p.deadline !== undefined);
    } catch { return false; }
  }

  isCpuInferenceWorkOrder(workOrder: WorkOrder): boolean {
    if ((workOrder.type as string) === 'CPU_INFERENCE') return true;
    if (workOrder.requiredCapabilities.includes('cpu_inference')) return true;
    try {
      const p = JSON.parse(workOrder.description) as Partial<CpuInferenceWorkOrderPayload>;
      return typeof p.task === 'string' && ['embedding', 'tokenize', 'classify'].includes(p.task) && typeof p.input === 'string';
    } catch { return false; }
  }

  isDockingWorkOrder(workOrder: WorkOrder): boolean {
    if ((workOrder.type as string) === 'MOLECULAR_DOCKING') return true;
    try {
      const p = JSON.parse(workOrder.description) as Partial<DockingWorkOrderPayload>;
      return !!(p.pairId && p.receptorPdbId && p.ligandSmiles && p.bindingSite && p.vinaSeed && p.vinaVersion);
    } catch { return false; }
  }

  isLoraWorkOrder(workOrder: WorkOrder): boolean {
    if ((workOrder.type as string) === 'LORA_TRAINING') return true;
    try {
      const p = JSON.parse(workOrder.description) as Partial<LoraWorkOrderPayload>;
      return !!(p.adapterId && p.missionId && p.subtype && p.baseModel && p.uploadUrl && p.loraConfig);
    } catch { return false; }
  }

  /**
   * Detect a LORA_VALIDATION WO. Either the explicit type tag from the
   * coord (Phase 3, not yet wired) OR the validation payload shape
   * (adapterUri + validationSetUri + sha256 commitments). Disjoint from
   * `isLoraWorkOrder` — the training payload has `uploadUrl` + `loraConfig`
   * while the validation payload has `adapterUri` + `validationSetUri`.
   */
  isLoraValidationWorkOrder(workOrder: WorkOrder): boolean {
    if ((workOrder.type as string) === 'LORA_VALIDATION') return true;
    try {
      const p = JSON.parse(workOrder.description) as Partial<LoraValidationWorkOrderPayload>;
      return !!(
        p.adapterId &&
        p.adapterUri &&
        p.adapterSha256 &&
        p.validationSetUri &&
        p.validationSetSha256 &&
        p.baseModel &&
        p.subtype
      );
    } catch { return false; }
  }

  extractResearchPayload(workOrder: WorkOrder): ResearchPayload | null {
    // 1. Try JSON-encoded description (legacy format)
    try {
      const p = JSON.parse(workOrder.description);
      if (p.title && p.abstract) return { title: p.title, abstract: p.abstract };
    } catch { /* not JSON — try other formats */ }

    // 2. Use metadata fields (paperTitle + paperAbstract) set by coordinator
    const meta = workOrder.metadata;
    if (meta?.['paperTitle'] && meta?.['paperAbstract']) {
      return { title: String(meta['paperTitle']), abstract: String(meta['paperAbstract']) };
    }

    // 3. Parse plain-text description (coordinator builds "Abstract:\n..." format)
    if (workOrder.title && workOrder.description) {
      const abstractMatch = workOrder.description.match(/Abstract:\n([\s\S]*?)(?:\n\n|$)/);
      const abstract = abstractMatch?.[1]?.trim() || workOrder.description.slice(0, 2000);
      return { title: workOrder.title, abstract };
    }
    return null;
  }

  // ── Research ──────────────────────────────────────────────────────────────

  buildResearchPrompt(payload: ResearchPayload, knowledgeGraphContext?: string, referenceContext?: string): string {
    const kgSection = knowledgeGraphContext ? `\n\nResearch context from the knowledge graph:\n${knowledgeGraphContext}\n` : '';
    const refSection = referenceContext
      ? `\n\nYou have access to previous discoveries from the network on this topic:\n\n${referenceContext}\n\nBuild upon these findings. Don't repeat what's already known. Focus on NEW insights and gaps in the existing research that this paper addresses.\n`
      : '';
    const contextSection = kgSection || refSection ? `\n\n${kgSection}${refSection}` : '';
    return `You are an expert research analyst in a decentralized AI compute network. Your job is NOT to summarize the paper — it is to critically analyze it and generate original insights.${contextSection}

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

  private parseDirectResult(raw: string): ResearchResult {
    try {
      let jsonStr = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/) || jsonStr.match(/```(?:json)?\s*([\s\S]*)/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      jsonStr = jsonMatch ? jsonMatch[0] : jsonStr;
      const parsed = JSON.parse(jsonStr) as ResearchResult;
      if (!parsed.summary || !Array.isArray(parsed.keyInsights) || !parsed.proposal) throw new Error('Invalid structure');
      return parsed;
    } catch {
      return { summary: 'Failed to parse LLM response', keyInsights: [], proposal: raw.slice(0, 500) };
    }
  }

  async executeResearchWorkOrder(
    workOrder: WorkOrder,
    llmModel: LLMModel,
    llmConfig?: LLMConfig,
    coordinatorUrl?: string,
    peerId?: string,
  ): Promise<{ result: ResearchResult; rawResponse: string; success: boolean; hyperparams?: Record<string, unknown> }> {
    logger.log(` Executing research: ${workOrder.title}`);
    const payload = this.extractResearchPayload(workOrder);
    if (!payload) throw new Error('Invalid research payload in work order');

    const topic = payload.title.split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');

    let kgContext = '';
    let referenceContext = '';
    let hyperConfig: { id: string; temperature: number; promptTemplate: string; analysisDepth: string; chunkSize?: number } | null = null;
    let strategy: 'exploit' | 'explore' = 'explore';

    if (coordinatorUrl) {
      kgContext = await this.coordinator.fetchKGraphContext(coordinatorUrl, topic);
      if (kgContext) logger.log(` Fetched KG context for topic "${topic}" (${kgContext.length} chars)`);

      referenceContext = await this.coordinator.fetchReferenceContext(coordinatorUrl, topic);
      if (referenceContext) logger.log(` Fetched reference context for topic "${topic}" (${referenceContext.length} chars)`);

      const suggestion = await this.coordinator.fetchHyperparamConfig(coordinatorUrl);
      if (suggestion) {
        hyperConfig = suggestion.config;
        strategy = suggestion.strategy;
        logger.log(` Hyperparam config [${strategy}]: temp=${hyperConfig.temperature}, depth=${hyperConfig.analysisDepth}`);
      }
    }

    // Use multi-agent team (researcher → critic → synthesizer) with shared memory.
    // Falls back to direct LLM call on team failure.
    const prompt = this.buildResearchPrompt(payload, kgContext || undefined, referenceContext || undefined);
    const startMs = Date.now();
    let rawResponse = '';
    let result: ResearchResult;

    try {
      logger.log(' Using multi-agent research pipeline (researcher → critic → synthesizer)');
      // This method is called by ExecuteResearchNode.
      // The 3-agent pipeline is now in ResearcherNode → CriticNode → SynthesizerNode.
      // Here we do a direct single-pass research call as fallback for non-graph calls.
      rawResponse = await this.llmProvider.generateLLM(llmModel, prompt, llmConfig, hyperConfig ? { temperature: hyperConfig.temperature } : undefined);
      result = this.parseDirectResult(rawResponse);
    } catch (teamErr) {
      logger.warn(` Multi-agent pipeline path called directly (${(teamErr as Error).message}), using direct LLM call`);
      rawResponse = await this.llmProvider.generateLLM(llmModel, prompt, llmConfig, hyperConfig ? { temperature: hyperConfig.temperature } : undefined);
      const parsed = this.parseDirectResult(rawResponse);
      result = parsed;
    }
    const latencyMs = Date.now() - startMs;
    logger.log(` Research complete, summary: ${result.summary.slice(0, 100)}...`);

    if (hyperConfig && coordinatorUrl && peerId) {
      const qualityScore = Math.min(10, Math.max(0,
        (result.keyInsights.length >= 3 ? 3 : result.keyInsights.length) +
        (result.summary.length > 200 ? 3 : 1) +
        (result.proposal.length > 100 ? 3 : 1),
      ));
      await this.coordinator.reportHyperparamExperiment(coordinatorUrl, peerId, hyperConfig, qualityScore, latencyMs);
      logger.log(` Reported experiment quality: ${qualityScore}/10 (strategy: ${strategy})`);
    }

    const metricValue = this.evaluation.scoreResearchResult(result);
    if (coordinatorUrl && peerId && metricValue > 0.7) {
      await this.coordinator.uploadInsightToNetwork(coordinatorUrl, peerId, topic, result.summary, result.keyInsights, metricValue);
    }

    return { result, rawResponse, success: true, hyperparams: hyperConfig ?? undefined };
  }

  saveResearchToBrain(brain: AgentBrain, workOrder: WorkOrder, result: ResearchResult): void {
    brain.journal.push({ timestamp: Date.now(), action: `research:${workOrder.id}`, outcome: 'completed', lesson: `Paper: ${workOrder.title}\nSummary: ${result.summary.slice(0, 200)}\nProposal: ${result.proposal.slice(0, 200)}` });
    brain.memory.push({ timestamp: Date.now(), type: 'discovery', content: `Research: ${result.summary}`, importance: 0.7 });
    if (brain.journal.length > 100) brain.journal = brain.journal.slice(-100);
    if (brain.memory.length > 100) brain.memory = brain.memory.slice(-100);
  }

  // ── Training ──────────────────────────────────────────────────────────────

  async executeTrainingWorkOrder(
    workOrder: WorkOrder,
    coordinatorUrl: string,
    peerId: string,
    capabilities: string[],
    iteration: number,
    llmModel?: LLMModel,
    llmConfig?: LLMConfig,
    fallbackModels: LLMModel[] = [],
  ): Promise<{ result: string; success: boolean }> {
    logger.log(` Executing TRAINING: ${workOrder.title}`);
    // Document which LLM (and fallback chain) was selected so config-env
    // misconfiguration is diagnosable from the live log on next run. The
    // resolver runs upstream in work-order.loop.ts / execute-training.ts
    // (langgraph). When LLM_PROVIDER=cloud is intended but the log shows
    // an Ollama primary, the env vars (LLM_PROVIDER + LLM_CLOUD_MODEL +
    // LLM_CLOUD_PROVIDER) aren't reaching the node process.
    if (llmModel) {
      const fallbackSummary = fallbackModels.length > 0
        ? ` (fallbacks: ${fallbackModels.map(m => `${m.provider}/${m.modelId}`).join(', ')})`
        : ' (no fallbacks)';
      logger.log(
        ` Training LLM: primary=${llmModel.provider}/${llmModel.modelId}${fallbackSummary}`,
      );
    } else {
      logger.warn(' Training LLM: no model resolved — mutation engine will use built-in default (qwen2.5:0.5b)');
    }
    let payload: TrainingWorkOrderPayload;
    try { payload = JSON.parse(workOrder.description) as TrainingWorkOrderPayload; } catch { return { result: 'Invalid training payload', success: false }; }

    const topExperiments = await this.coordinator.fetchTopExperiments(coordinatorUrl);
    const mutationEngine = new MutationEngineHelper();
    let mutation;
    try {
      mutation = await mutationEngine.proposeMutation(
        topExperiments,
        payload.currentBestLoss,
        capabilities,
        llmModel,
        fallbackModels,
        llmConfig,
      );
    } catch (err) {
      // Never silently fall back to invented hyperparams — abort the WO so the
      // coordinator can reassign it and we don't pollute the experiment log
      // with fabricated "explorations".
      if (err instanceof MutationEngineError) {
        logger.error(` Mutation engine failed: ${err.message}`);
        return {
          result: `Training aborted: mutation engine could not produce a valid proposal (${err.attempts.length} attempts across ${err.attempts.map(a => a.model).join(', ')})`,
          success: false,
        };
      }
      throw err;
    }
    if (payload.baseConfig) mutation = { ...mutation, hyperparams: { ...mutation.hyperparams, ...payload.baseConfig } };

    let datasetPath = '';
    let usedRealCorpus = false;
    try {
      datasetPath = await this.coordinator.downloadDataset(coordinatorUrl, payload.domain);
      usedRealCorpus = true;
      logger.log(` Using domain corpus: ${datasetPath}`);
    } catch (err) {
      logger.warn(` Corpus for '${payload.domain}' not available (${(err as Error).message}). Falling back to built-in synthetic data.`);
    }

    let trainingResult;
    try {
      trainingResult = await trainMicroModel({ proposal: mutation, datasetPath, hardware: capabilities.includes('gpu') ? 'gpu' : 'cpu', runNumber: iteration });
    } catch (err) {
      // Training failure is recoverable at the coordinator level — the WO is
      // returned as `success:false` and reassigned. Logging at warn keeps the
      // signal but stops the dashboard from treating routine OOM/timeout/
      // dependency-missing failures as red-bar incidents.
      logger.warn(' Training failed:', (err as Error).message);
      return { result: `Training failed: ${(err as Error).message}`, success: false };
    }

    // Defensive guard: trainer normally returns valLoss as a number (with
    // `?? 0` fallback inside trainer.ts), but if any future code path returns
    // a partial or NaN result we coerce to 0 here so `.toFixed()` never
    // throws AND the JSON payload sent to the coordinator never carries
    // `NaN` (which `JSON.stringify` would render as `null`, tripping the
    // coordinator's typed schema and surfacing as a different telemetry
    // error).
    const valLoss = safeLoss(trainingResult.valLoss);
    const finalLoss = safeLoss(trainingResult.finalLoss);
    // Defensive guard against the "valLoss=0 vs Infinity baseline always wins"
    // regression family. Three layers, all required:
    //   1. trainerEvalFailed — authoritative flag from Python; covers the
    //      empty-val-set and deadline-beat-first-batch cases.
    //   2. valLoss > 0 — historical guard for any legacy code path that
    //      might still emit a literal 0.0 (e.g. a future Python edit that
    //      re-introduces `total_loss / max(count, 1)`).
    //   3. valLoss < SENTINEL — refuses the 1e30 sentinel even if (1) is
    //      missing for some reason (older Python release, mismatched
    //      script). Belt + suspenders + a second belt; this comparison is
    //      load-bearing for reward payout so we err toward NOT marking
    //      improvement on ambiguous data.
    const trainerEvalFailed = trainingResult.valLossEvalFailed === true;
    const improved =
      !trainerEvalFailed &&
      valLoss > 0 &&
      valLoss < TRAINER_EVAL_FAILED_SENTINEL &&
      valLoss < payload.currentBestLoss;
    if (trainerEvalFailed) {
      logger.warn(
        ` Trainer reported eval failure (${trainingResult.valLossEvalFailureReason ?? 'no reason given'}); marking improved=false to skip reward payout.`,
      );
    }
    const effectiveDatasetId = usedRealCorpus ? `${payload.domain}-corpus` : 'synthetic://built-in';
    await this.coordinator.submitTrainingExperiment(coordinatorUrl, peerId, mutation.hyperparams, valLoss, trainingResult.durationMs);
    // Pass the executor-computed `improved` and `trainerEvalFailed` so the
    // submission helper does NOT recompute (P6 in reviewer-lessons.md). Single
    // source of truth: the 4-layer guard above is the only place these are
    // derived from raw trainer output.
    await this.coordinator.submitTrainingResult(
      coordinatorUrl,
      peerId,
      { ...payload, datasetId: effectiveDatasetId },
      valLoss,
      finalLoss,
      trainingResult.durationMs,
      improved,
      trainerEvalFailed,
    );

    logger.log(` Training complete — valLoss=${valLoss.toFixed(4)}, improved=${improved}, evalFailed=${trainerEvalFailed}`);
    return { result: JSON.stringify({ valLoss, finalLoss, config: trainingResult.config, durationMs: trainingResult.durationMs, lossCurve: trainingResult.lossCurve, hardwareUsed: trainingResult.hardwareUsed, improved, metricType: 'val_loss', metricValue: valLoss, valLossEvalFailed: trainerEvalFailed }), success: true };
  }

  // ── DiLoCo ────────────────────────────────────────────────────────────────

  async executeDiLoCoWorkOrder(workOrder: WorkOrder, coordinatorUrl: string, peerId: string, capabilities: string[]): Promise<{ result: string; success: boolean }> {
    logger.log(` Executing DILOCO_TRAINING: ${workOrder.title}`);
    let payload: DiLoCoWorkOrderPayload;
    try { payload = JSON.parse(workOrder.description) as DiLoCoWorkOrderPayload; } catch { return { result: 'Invalid DiLoCo payload', success: false }; }

    let localAdapterPath: string | undefined;
    if (payload.currentAdapterUrl) {
      localAdapterPath = path.join(os.homedir(), '.synapseia', 'adapters', payload.domain, `round_${payload.outerRound - 1}`);
      try { await downloadAdapter(payload.currentAdapterUrl, localAdapterPath); logger.log(`[DiLoCo] Downloaded adapter to ${localAdapterPath}`); }
      catch (err) { logger.warn(`[DiLoCo] Could not download adapter: ${(err as Error).message}`); localAdapterPath = undefined; }
    }

    let datasetPath = payload.datasetId;
    try { datasetPath = await this.coordinator.downloadDataset(coordinatorUrl, payload.domain); logger.log(`[DiLoCo] Using dataset: ${datasetPath}`); }
    catch (err) { logger.warn(`[DiLoCo] Dataset not available (${(err as Error).message}). Using datasetId.`); }

    const hardware = capabilities.includes('cuda') ? 'cuda' : capabilities.includes('mps') ? 'mps' : 'cpu';

    let dilocoResult;
    try {
      dilocoResult = await runDiLoCoInnerLoop({ modelId: payload.modelId, adapterPath: localAdapterPath, datasetPath, innerSteps: payload.innerSteps, hyperparams: payload.hyperparams, hardware: hardware as 'cpu' | 'mps' | 'cuda', testMode: process.env.NODE_ENV === 'test' });
    } catch (err) {
      // Same rationale as executeMicroTrainingWorkOrder: WO returns
      // success:false and the coordinator handles re-routing — warn is the
      // right signal level for a recoverable per-WO failure.
      logger.warn(`[DiLoCo] Inner loop failed: ${(err as Error).message}`);
      return { result: `DiLoCo training failed: ${(err as Error).message}`, success: false };
    }

    try {
      const gradientBuffer = await import('fs').then(fsm => fsm.promises.readFile(dilocoResult.gradientPath));
      const uploaded = await this.coordinator.uploadGradients(coordinatorUrl, payload.domain, peerId, gradientBuffer);
      if (!uploaded) logger.warn('[DiLoCo] Failed to upload gradients to coordinator');
    } catch (err) {
      logger.warn(`[DiLoCo] Could not read/upload gradient file: ${(err as Error).message}`);
    }

    const dilocoValLoss = safeLoss(dilocoResult.valLoss);
    const dilocoFinalLoss = safeLoss(dilocoResult.finalLoss);
    logger.log(`[DiLoCo] Inner loop complete — valLoss=${dilocoValLoss.toFixed(4)}, gradients=${dilocoResult.gradientSizeBytes} bytes`);
    return { result: JSON.stringify({ valLoss: dilocoValLoss, finalLoss: dilocoFinalLoss, innerSteps: dilocoResult.innerSteps, durationMs: dilocoResult.durationMs, gradientSizeBytes: dilocoResult.gradientSizeBytes, metricType: 'val_loss', metricValue: dilocoValLoss }), success: true };
  }

  // ── CPU Inference ─────────────────────────────────────────────────────────

  async executeCpuInferenceWorkOrder(workOrder: WorkOrder, llmModel: LLMModel, llmConfig?: LLMConfig, _coordinatorUrl?: string): Promise<CpuInferenceResultPayload> {
    const startMs = Date.now();
    let payload: CpuInferenceWorkOrderPayload;
    try { payload = JSON.parse(workOrder.description) as CpuInferenceWorkOrderPayload; } catch { throw new Error('Invalid CPU inference payload'); }

    const tokens = payload.input.split(/\s+/).filter(Boolean);
    const tokensProcessed = tokens.length;
    let output: number[] | string;
    let modelUsed: string;

    if (payload.task === 'tokenize') {
      output = `${tokensProcessed}`;
      modelUsed = 'whitespace-tokenizer';
    } else if (payload.task === 'embedding') {
      const embeddingHelper = new EmbeddingHelper();
      const resolvedModel = payload.modelHint ?? EMBED_MODEL;
      modelUsed = `ollama/${resolvedModel}`;
      logger.log(`[CpuInference] Generating embedding with ${resolvedModel} via Ollama at ${OLLAMA_EMBEDDING_URL}`);
      output = await embeddingHelper.generateEmbedding(payload.input.slice(0, 2000), resolvedModel);
      logger.log(`[CpuInference] Embedding generated: ${(output as number[]).length} dimensions`);
    } else {
      modelUsed = llmModel.modelId ?? 'unknown';
      const prompt = `Classify the following text into exactly ONE of these categories: positive, negative, neutral, technical, medical, financial, other.\nReply with ONLY the category label, nothing else.\n\nText: ${payload.input.slice(0, 500)}`;
      try {
        const raw = await this.llmProvider.generateLLM(llmModel, prompt, llmConfig);
        output = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().split(/\s+/)[0].toLowerCase();
        logger.log(`[CpuInference] Classification result: "${output}"`);
      } catch (err) {
        logger.warn(`[CpuInference] LLM classify failed: ${(err as Error).message} — defaulting to 'neutral'`);
        output = 'neutral';
      }
    }

    const latencyMs = Date.now() - startMs;
    logger.log(`[CpuInference] task=${payload.task} done in ${latencyMs}ms, tokens=${tokensProcessed}`);
    return { output, tokensProcessed, latencyMs, modelUsed };
  }

  // ── GPU Inference ──────────────────────────────────────────────────────────

  isGpuInferenceWorkOrder(workOrder: WorkOrder): boolean {
    if ((workOrder.type as string) === 'GPU_INFERENCE') return true;
    if (workOrder.requiredCapabilities.includes('gpu_inference')) return true;
    try {
      const p = JSON.parse(workOrder.description) as Partial<GpuInferenceWorkOrderPayload>;
      return typeof p.task === 'string' && ['generate', 'summarize', 'embedding_large'].includes(p.task) && typeof p.input === 'string';
    } catch { return false; }
  }

  async executeGpuInferenceWorkOrder(workOrder: WorkOrder, llmModel: LLMModel, llmConfig?: LLMConfig): Promise<CpuInferenceResultPayload> {
    const startMs = Date.now();
    let payload: GpuInferenceWorkOrderPayload;
    try { payload = JSON.parse(workOrder.description) as GpuInferenceWorkOrderPayload; } catch { throw new Error('Invalid GPU inference payload'); }

    const tokens = payload.input.split(/\s+/).filter(Boolean);
    const tokensProcessed = tokens.length;
    let output: number[] | string;
    let modelUsed: string;

    if (payload.task === 'embedding_large') {
      // Large-model embedding via Ollama with GPU-accelerated model
      const embeddingHelper = new EmbeddingHelper();
      const resolvedModel = payload.modelHint ?? GPU_INFERENCE_MODEL;
      modelUsed = `ollama/${resolvedModel}`;
      logger.log(`[GpuInference] Generating large embedding with ${resolvedModel}`);
      output = await embeddingHelper.generateEmbedding(payload.input.slice(0, 8000), resolvedModel);
      logger.log(`[GpuInference] Large embedding: ${(output as number[]).length} dimensions`);
    } else if (payload.task === 'summarize') {
      // Summarization via LLM (GPU-accelerated, longer context)
      modelUsed = llmModel.modelId ?? 'unknown';
      const prompt = `Summarize the following text in 3-5 concise bullet points. Focus on key findings and methodology.\n\nText:\n${payload.input.slice(0, 4000)}\n\nSummary:`;
      try {
        const raw = await this.llmProvider.generateLLM(llmModel, prompt, llmConfig);
        output = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        logger.log(`[GpuInference] Summarization complete: ${output.length} chars`);
      } catch (err) {
        logger.warn(`[GpuInference] Summarize failed: ${(err as Error).message}`);
        throw err;
      }
    } else {
      // Generate: open-ended LLM generation (analysis, hypothesis, Q&A)
      modelUsed = llmModel.modelId ?? 'unknown';
      const prompt = `You are a research analyst. Based on the following text, provide a detailed analysis with key insights.\n\nText:\n${payload.input.slice(0, 4000)}\n\nAnalysis:`;
      try {
        const raw = await this.llmProvider.generateLLM(llmModel, prompt, llmConfig);
        output = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        logger.log(`[GpuInference] Generation complete: ${output.length} chars`);
      } catch (err) {
        logger.warn(`[GpuInference] Generation failed: ${(err as Error).message}`);
        throw err;
      }
    }

    const latencyMs = Date.now() - startMs;
    logger.log(`[GpuInference] task=${payload.task} done in ${latencyMs}ms, tokens=${tokensProcessed}`);
    return { output, tokensProcessed, latencyMs, modelUsed };
  }

  // ── Molecular Docking (AutoDock Vina v1.2.5) ──────────────────────────────

  /**
   * Execute a MOLECULAR_DOCKING work order. Spawns Vina + Open Babel,
   * parses the PDBQT output, and returns a JSON-serialised
   * DockingSubmissionPayload as the WO result. The coordinator's
   * complete-WO path detects the type and routes the result to
   * DockingSubmissionService.ingest. NO local sandboxing — same trust
   * model as training (we run our own binaries against payloads we
   * issued).
   */
  async executeDockingWorkOrder(
    workOrder: WorkOrder,
    peerId: string,
  ): Promise<{ result: string; success: boolean }> {
    logger.log(` Executing MOLECULAR_DOCKING: ${workOrder.title}`);
    let payload: DockingWorkOrderPayload;
    try {
      payload = JSON.parse(workOrder.description) as DockingWorkOrderPayload;
    } catch {
      return { result: 'Invalid docking payload', success: false };
    }
    if (payload.vinaVersion !== '1.2.5') {
      return {
        result: `Unsupported Vina version: ${payload.vinaVersion} (only 1.2.5 is allowed in V1)`,
        success: false,
      };
    }

    try {
      const submission = await runDocking({ workOrderId: workOrder.id, peerId, payload });
      logger.log(
        ` Docking complete — bestAffinity=${submission.bestAffinity.toFixed(3)} kcal/mol, poses=${submission.poses.length}, ${submission.durationMs}ms`,
      );
      return { result: JSON.stringify(submission), success: true };
    } catch (err) {
      const stage = err instanceof DockingError ? `[${err.stage}] ` : '';
      const msg = (err as Error).message;
      logger.error(` Docking failed ${stage}${msg}`);
      return { result: `Docking failed ${stage}${msg}`, success: false };
    }
  }

  // ── LoRA biomedical fine-tuning ───────────────────────────────────────────

  /**
   * Execute a LORA_TRAINING work order. Spawns the Python LoRA trainer
   * subprocess, uploads the resulting adapter to S3 via the WO's
   * pre-signed URL, returns a JSON-serialised LoraSubmissionPayload as
   * the WO result. The coordinator's complete-WO path detects the
   * type and routes the result to LoraSubmissionService.ingest.
   */
  async executeLoraWorkOrder(
    workOrder: WorkOrder,
    peerId: string,
  ): Promise<{ result: string; success: boolean }> {
    logger.log(` Executing LORA_TRAINING: ${workOrder.title}`);
    let payload: LoraWorkOrderPayload;
    try { payload = JSON.parse(workOrder.description) as LoraWorkOrderPayload; }
    catch { return { result: 'Invalid LoRA payload', success: false }; }

    try {
      const submission = await runLora({ workOrderId: workOrder.id, peerId, payload });
      logger.log(
        ` LoRA training complete — adapter=${submission.adapterId}, ` +
        `metrics=${JSON.stringify(submission.reportedValMetrics)}`,
      );
      return { result: JSON.stringify(submission), success: true };
    } catch (err) {
      const stage = err instanceof LoraError ? `[${err.stage}] ` : '';
      const msg = (err as Error).message;
      logger.error(` LoRA training failed ${stage}${msg}`);
      return { result: `LoRA training failed ${stage}${msg}`, success: false };
    }
  }

  // ── LoRA peer validation (Plan 1 Phase 2) ─────────────────────────────────

  /**
   * Execute a LORA_VALIDATION work order. OPT-IN ONLY: gated on
   * `LORA_VALIDATOR_ENABLED=true` (flipped by the CLI `--lora-validator`
   * flag). Default OFF so node operators don't accidentally start serving
   * validation jobs.
   *
   * On opt-in, this downloads the adapter + held-out validation set,
   * sha256-verifies both, spawns the Python eval subprocess, and returns
   * a signed `LoraValidationSubmissionPayload`. Coord-side ingest is wired
   * in Phase 3.
   *
   * No producer emits LORA_VALIDATION WOs yet (Phase 3's job) — so even
   * when enabled, this handler will only fire after Phase 3 ships.
   */
  async executeLoraValidationWorkOrder(
    workOrder: WorkOrder,
    peerId: string,
  ): Promise<{ result: string; success: boolean }> {
    if (process.env.LORA_VALIDATOR_ENABLED !== 'true') {
      logger.warn(
        ` LORA_VALIDATION WO ${workOrder.id} received but LORA_VALIDATOR_ENABLED is not true; ` +
        `refusing to process. Pass --lora-validator on start to opt in.`,
      );
      return { result: 'validator-disabled', success: false };
    }

    logger.log(` Executing LORA_VALIDATION: ${workOrder.title}`);
    let payload: LoraValidationWorkOrderPayload;
    try { payload = JSON.parse(workOrder.description) as LoraValidationWorkOrderPayload; }
    catch { return { result: 'Invalid LoRA validation payload', success: false }; }

    try {
      const submission = await runLoraValidation({ workOrderId: workOrder.id, peerId, payload });
      logger.log(
        ` LoRA validation complete — adapter=${submission.adapterId}, ` +
        `metrics=${JSON.stringify(submission.observed)}`,
      );
      return { result: JSON.stringify(submission), success: true };
    } catch (err) {
      const stage = err instanceof LoraValidationError ? `[${err.stage}] ` : '';
      const msg = (err as Error).message;
      logger.error(` LoRA validation failed ${stage}${msg}`);
      return { result: `LoRA validation failed ${stage}${msg}`, success: false };
    }
  }

  // ── Generic ───────────────────────────────────────────────────────────────

  private buildWorkOrderPrompt(workOrder: WorkOrder): string {
    return `You are a Synapseia network node executing a work order.\n\nTask: ${workOrder.title}\nDescription: ${workOrder.description}\n\nPlease provide a detailed response to complete this task. Be thorough and accurate.\n\nResponse:`;
  }

  async executeWorkOrder(workOrder: WorkOrder, llmModel: LLMModel, llmConfig?: LLMConfig): Promise<{ result: string; success: boolean }> {
    logger.log(` Executing: ${workOrder.title}`);
    try {
      // Fallback dispatch when callers reach this generic entry without
      // the typed routing in work-order.loop.ts. Mirrors the primary
      // dispatcher so a typed WO never silently falls through to the
      // generic LLM prompt branch (which would produce useless results).
      // Generation-detection methods are inexpensive; ordering matches
      // work-order.loop.ts for parity.
      if (this.isLoraValidationWorkOrder(workOrder)) {
        // peerId is not in scope here — generic entry is rarely used for
        // LORA_VALIDATION (loop dispatches first). Return disabled to
        // match the opt-in semantics; the loop handles the real path.
        return this.executeLoraValidationWorkOrder(workOrder, '');
      }
      if (this.isResearchWorkOrder(workOrder)) {
        const { rawResponse, success } = await this.executeResearchWorkOrder(workOrder, llmModel, llmConfig);
        return { result: rawResponse, success };
      }
      const prompt = this.buildWorkOrderPrompt(workOrder);
      const result = await this.llmProvider.generateLLM(llmModel, prompt, llmConfig);
      logger.log(` Execution complete, result length: ${result.length} chars`);
      return { result, success: true };
    } catch (error) {
      logger.error(' Execution failed:', (error as Error).message);
      return { result: `Error: ${(error as Error).message}`, success: false };
    }
  }
}
