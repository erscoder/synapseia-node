/**
 * Mutation Engine - LLM-powered hyperparameter mutation
 */

import { Injectable } from '@nestjs/common';
import { LlmProviderHelper, type LLMModel, type LLMConfig } from '../llm/llm-provider';
import logger from '../../utils/logger';
import type { Experiment, Hyperparams } from '../../types';

export interface MutationProposal {
  model: LLMModel;
  type: 'explore' | 'improve';
  baseExperimentId: string | null;
  hyperparams: Hyperparams;
  reasoning: string;
  estimatedCost?: number;
}

/**
 * MutationEngineError is thrown when the mutation planner cannot obtain a
 * well-formed proposal from any candidate LLM. Training WOs should fail
 * visibly rather than fall back to invented hyperparams.
 */
export class MutationEngineError extends Error {
  constructor(message: string, readonly attempts: { model: string; error: string }[]) {
    super(message);
    this.name = 'MutationEngineError';
  }
}

@Injectable()
export class MutationEngineHelper {
  private readonly llmProvider = new LlmProviderHelper();

  /**
   * Propose a mutation via LLM. On parse/generation failure, retries the SAME
   * model with a stricter "JSON-only" prompt; then walks the fallback model
   * list. If every candidate fails, throws MutationEngineError — the training
   * WO should abort rather than run with fabricated hyperparams.
   *
   * @param fallbackModels - Extra models to try if the primary fails. Order matters.
   * @param llmConfig - Base URL / API key shared across candidates.
   */
  async proposeMutation(
    topExperiments: Experiment[],
    bestLoss: number,
    capabilities: string[],
    primaryModel: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
    fallbackModels: LLMModel[] = [],
    llmConfig?: LLMConfig,
  ): Promise<MutationProposal> {
    if (topExperiments.length === 0) {
      // No experiments yet — nothing to mutate from. This is the legitimate
      // cold-start path, not a failure fallback: the reasoning is honest.
      return {
        model: primaryModel,
        type: 'explore',
        baseExperimentId: null,
        hyperparams: {
          learningRate: 0.001, batchSize: 32, hiddenDim: 64, numLayers: 2,
          numHeads: 2, activation: 'gelu', normalization: 'layernorm',
          initScheme: 'xavier', warmupSteps: 50, weightDecay: 0.01,
          maxTrainSeconds: capabilities.includes('gpu') ? 180 : 60,
        },
        reasoning: 'Cold start: no prior experiments to mutate from, using neutral baseline configuration',
      };
    }

    const candidates = [primaryModel, ...fallbackModels];
    const basePrompt = this.buildPrompt(topExperiments, bestLoss, capabilities);
    const strictPrompt = this.buildStrictPrompt(topExperiments, bestLoss, capabilities);
    const attempts: { model: string; error: string }[] = [];

    for (const model of candidates) {
      for (const [attemptIdx, prompt] of [basePrompt, strictPrompt].entries()) {
        try {
          const response = await this.llmProvider.generateLLM(model, prompt, llmConfig);
          return this.parseMutationResponse(response, topExperiments, bestLoss, capabilities, model);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[MutationEngine] ${model.modelId} attempt ${attemptIdx + 1}/2 failed: ${msg.slice(0, 120)}`);
          attempts.push({ model: model.modelId, error: msg.slice(0, 200) });
        }
      }
    }

    throw new MutationEngineError(
      `All mutation candidates failed (${candidates.map(m => m.modelId).join(', ')}). Training WO cannot proceed with a valid mutation proposal.`,
      attempts,
    );
  }

  private buildStrictPrompt(topExperiments: Experiment[], bestLoss: number, capabilities: string[]): string {
    const hasGpu = capabilities.includes('gpu');
    const topIds = topExperiments.slice(0, 3).map(e => e.id).join(', ');
    return `Respond with ONE JSON object. NO prose, NO markdown, NO code fences. Start with { and end with }.

Top experiment ids: ${topIds}
Best loss: ${bestLoss.toFixed(4)}

Required schema (replace the placeholder values):
{"type":"explore","baseExperimentId":null,"hyperparams":{"learningRate":0.001,"batchSize":32,"hiddenDim":128,"numLayers":4,"numHeads":4,"activation":"gelu","normalization":"layernorm","initScheme":"xavier","warmupSteps":100,"weightDecay":0.01,"maxTrainSeconds":${hasGpu ? 180 : 60}},"reasoning":"short explanation"}

Rules: learningRate 0.0001-0.01; batchSize one of 16,32,64,128; hiddenDim one of 64,128,192,256; numLayers 2-8; numHeads one of 2,4,8; activation one of gelu,silu,relu; normalization one of layernorm,rmsnorm; initScheme one of xavier,kaiming,normal.

Output the JSON now:`;
  }

  private buildPrompt(topExperiments: Experiment[], bestLoss: number, capabilities: string[]): string {
    const expsJson = JSON.stringify(topExperiments.slice(0, 5), null, 2);
    const hasGpu = capabilities.includes('gpu');

    return `You are a machine learning researcher. Given these experiment results:

${expsJson}

The best loss so far is ${bestLoss.toFixed(4)}.

Available hardware: ${capabilities.join(' and ')}.

Propose a new hyperparameter configuration that could improve the loss.
Reason about WHY your changes should work based on the patterns you see.

Output JSON with this structure:
{
  "type": "explore" or "improve",
  "baseExperimentId": null or "experiment_id_string",
  "hyperparams": {
    "learningRate": 0.001, "batchSize": 32, "hiddenDim": 128, "numLayers": 4,
    "numHeads": 4, "activation": "gelu", "normalization": "layernorm",
    "initScheme": "xavier", "warmupSteps": 100, "weightDecay": 0.01,
    "maxTrainSeconds": ${hasGpu ? 180 : 60}
  },
  "reasoning": "Explanation of why this mutation should work"
}

Constraints:
- learningRate: 0.0001 to 0.01
- batchSize: 16, 32, 64, 128
- hiddenDim: 64, 128, 192, 256
- numLayers: 2 to 8
- numHeads: 2, 4, 8
- activation: 'gelu', 'silu', 'relu'
- normalization: 'layernorm', 'rmsnorm'
- initScheme: 'xavier', 'kaiming', 'normal'`;
  }

  private parseMutationResponse(
    response: string, topExperiments: Experiment[], bestLoss: number, capabilities: string[],
    sourceModel: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
  ): MutationProposal {
    const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse JSON from LLM response');

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr) as any;

    if (!parsed.hyperparams || typeof parsed.hyperparams !== 'object') {
      throw new Error('LLM response missing hyperparams object');
    }

    // Coerce to number and replace non-finite values with the default. LLMs
    // occasionally emit strings ("four"), nulls, or NaN — without this step
    // those leak through clampValue as NaN and then JSON.stringify converts
    // them to "null", crashing the Python trainer with "'NoneType'" errors.
    const num = (v: unknown, fallback: number): number => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
      return Number.isFinite(n) ? n : fallback;
    };

    const hasGpu = capabilities.includes('gpu');
    const hyperparams: Hyperparams = {
      learningRate: this.clampValue(num(parsed.hyperparams?.learningRate, 0.001), 0.0001, 0.01),
      batchSize: this.clampToBatch(num(parsed.hyperparams?.batchSize, 32)),
      hiddenDim: this.clampToDimension(num(parsed.hyperparams?.hiddenDim, 128)),
      numLayers: Math.round(this.clampValue(num(parsed.hyperparams?.numLayers, 4), 2, 8)),
      numHeads: this.clampToHeads(num(parsed.hyperparams?.numHeads, 4)),
      activation: this.validateActivation(parsed.hyperparams?.activation),
      normalization: this.validateNormalization(parsed.hyperparams?.normalization),
      initScheme: this.validateInitScheme(parsed.hyperparams?.initScheme),
      warmupSteps: Math.round(this.clampValue(num(parsed.hyperparams?.warmupSteps, 100), 0, 1000)),
      weightDecay: this.clampValue(num(parsed.hyperparams?.weightDecay, 0.01), 0, 0.1),
      maxTrainSeconds: hasGpu
        ? Math.round(this.clampValue(num(parsed.hyperparams?.maxTrainSeconds, 180), 60, 300))
        : Math.round(this.clampValue(num(parsed.hyperparams?.maxTrainSeconds, 60), 30, 120)),
    };

    return {
      model: sourceModel,
      type: parsed.type === 'explore' || parsed.type === 'improve' ? parsed.type : 'explore',
      baseExperimentId: parsed.baseExperimentId || null,
      hyperparams,
      reasoning: parsed.reasoning || 'Proposed mutation',
    };
  }

  private clampValue(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private clampToBatch(value: number): number {
    return [16, 32, 64, 128].reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev);
  }

  private clampToDimension(value: number): number {
    return [64, 128, 192, 256].reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev);
  }

  private clampToHeads(value: number): number {
    return [2, 4, 8].reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev);
  }

  private validateActivation(value: any): 'gelu' | 'silu' | 'relu' {
    return ['gelu', 'silu', 'relu'].includes(value) ? value : 'gelu';
  }

  private validateNormalization(value: any): 'layernorm' | 'rmsnorm' {
    return ['layernorm', 'rmsnorm'].includes(value) ? value : 'layernorm';
  }

  private validateInitScheme(value: any): 'xavier' | 'kaiming' | 'normal' {
    return ['xavier', 'kaiming', 'normal'].includes(value) ? value : 'xavier';
  }
}
