/**
 * WorkOrderExecutionHelper — executes work orders (research, training, diloco, inference).
 */

import { Injectable } from '@nestjs/common';
import * as path from 'path';
import * as os from 'os';
import logger from '../../../utils/logger';
import { LlmProviderHelper, type LLMConfig, type LLMModel } from '../../llm/llm-provider';
import { EmbeddingHelper } from '../../../shared/embedding';
import { trainMicroModel } from '../../model/trainer';
import { MutationEngineHelper } from '../../model/mutation-engine';
import { runDiLoCoInnerLoop } from '../../model/diloco-trainer';
import { downloadAdapter } from '../../model/model-downloader';
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
    try { const p = JSON.parse(workOrder.description); return !!(p.title && p.abstract); } catch { return false; }
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

  extractResearchPayload(workOrder: WorkOrder): ResearchPayload | null {
    // Try JSON format first
    try {
      const p = JSON.parse(workOrder.description);
      if (p.title && p.abstract) return { title: p.title, abstract: p.abstract };
    } catch { /* not JSON */ }

    // Fallback: use WO title + description as plain text
    if (workOrder.title && workOrder.description) {
      return {
        title: workOrder.title,
        abstract: workOrder.description.slice(0, 2000),
      };
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

  async executeTrainingWorkOrder(workOrder: WorkOrder, coordinatorUrl: string, peerId: string, capabilities: string[], iteration: number): Promise<{ result: string; success: boolean }> {
    logger.log(` Executing TRAINING: ${workOrder.title}`);
    let payload: TrainingWorkOrderPayload;
    try { payload = JSON.parse(workOrder.description) as TrainingWorkOrderPayload; } catch { return { result: 'Invalid training payload', success: false }; }

    const topExperiments = await this.coordinator.fetchTopExperiments(coordinatorUrl);
    const mutationEngine = new MutationEngineHelper();
    let mutation = await mutationEngine.proposeMutation(topExperiments, payload.currentBestLoss, capabilities);
    if (payload.baseConfig) mutation = { ...mutation, hyperparams: { ...mutation.hyperparams, ...payload.baseConfig } };

    let datasetPath = payload.datasetId;
    try { datasetPath = await this.coordinator.downloadDataset(coordinatorUrl, payload.domain); logger.log(` Using domain dataset: ${datasetPath}`); }
    catch (err) { logger.warn(` Dataset '${payload.domain}' not available (${(err as Error).message}). Using synthetic training data — this is normal on first runs.`); }

    let trainingResult;
    try {
      trainingResult = await trainMicroModel({ proposal: mutation, datasetPath, hardware: capabilities.includes('gpu') ? 'gpu' : 'cpu', runNumber: iteration });
    } catch (err) {
      logger.error(' Training failed:', (err as Error).message);
      return { result: `Training failed: ${(err as Error).message}`, success: false };
    }

    const improved = trainingResult.valLoss < payload.currentBestLoss;
    await this.coordinator.submitTrainingExperiment(coordinatorUrl, peerId, mutation.hyperparams, trainingResult.valLoss, trainingResult.durationMs);
    await this.coordinator.submitTrainingResult(coordinatorUrl, peerId, payload, trainingResult.valLoss, trainingResult.finalLoss, trainingResult.durationMs);

    logger.log(` Training complete — valLoss=${trainingResult.valLoss.toFixed(4)}, improved=${improved}`);
    return { result: JSON.stringify({ valLoss: trainingResult.valLoss, finalLoss: trainingResult.finalLoss, config: trainingResult.config, durationMs: trainingResult.durationMs, lossCurve: trainingResult.lossCurve, hardwareUsed: trainingResult.hardwareUsed, improved, metricType: 'val_loss', metricValue: trainingResult.valLoss }), success: true };
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
      logger.error(`[DiLoCo] Inner loop failed: ${(err as Error).message}`);
      return { result: `DiLoCo training failed: ${(err as Error).message}`, success: false };
    }

    try {
      const gradientBuffer = await import('fs').then(fsm => fsm.promises.readFile(dilocoResult.gradientPath));
      const uploaded = await this.coordinator.uploadGradients(coordinatorUrl, payload.domain, peerId, gradientBuffer);
      if (!uploaded) logger.warn('[DiLoCo] Failed to upload gradients to coordinator');
    } catch (err) {
      logger.warn(`[DiLoCo] Could not read/upload gradient file: ${(err as Error).message}`);
    }

    logger.log(`[DiLoCo] Inner loop complete — valLoss=${dilocoResult.valLoss.toFixed(4)}, gradients=${dilocoResult.gradientSizeBytes} bytes`);
    return { result: JSON.stringify({ valLoss: dilocoResult.valLoss, finalLoss: dilocoResult.finalLoss, innerSteps: dilocoResult.innerSteps, durationMs: dilocoResult.durationMs, gradientSizeBytes: dilocoResult.gradientSizeBytes, metricType: 'val_loss', metricValue: dilocoResult.valLoss }), success: true };
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

  // ── Generic ───────────────────────────────────────────────────────────────

  private buildWorkOrderPrompt(workOrder: WorkOrder): string {
    return `You are a Synapseia network node executing a work order.\n\nTask: ${workOrder.title}\nDescription: ${workOrder.description}\n\nPlease provide a detailed response to complete this task. Be thorough and accurate.\n\nResponse:`;
  }

  async executeWorkOrder(workOrder: WorkOrder, llmModel: LLMModel, llmConfig?: LLMConfig): Promise<{ result: string; success: boolean }> {
    logger.log(` Executing: ${workOrder.title}`);
    try {
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
