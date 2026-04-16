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

/**
 * Extract the first balanced `{...}` JSON object from a raw LLM response.
 *
 * Why not a regex? The greedy `/\{[\s\S]*\}/` matches from the first `{` to
 * the LAST `}`, which for responses like `{"a":1}\n{"b":2}` produces the
 * whole span (multi-object) — JSON.parse then fails at the boundary with
 * "Unexpected non-whitespace character after JSON at position N". The
 * non-greedy variant has the opposite problem (stops too early on nested
 * objects).
 *
 * A brace counter that respects string literals + escapes always returns
 * the first syntactically balanced object, with no sensitivity to trailing
 * prose or a second object. Null if no balanced object is found.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
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
    // First try a fenced ```json { ... } ``` block (common markdown wrap).
    const fenced = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const jsonStr = fenced ? fenced[1] : extractFirstJsonObject(response);
    if (!jsonStr) throw new Error('Failed to parse JSON from LLM response');

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
    // CPU nodes (especially Docker containers sharing cores with Ollama at
    // 400%+ usage) can't progress through the larger configs in a reasonable
    // window — step 10 never prints, the parent times out at 10 min. Force
    // smaller defaults AND tighter caps so the LLM can't propose a model
    // that's structurally untrainable on this hardware.
    const hiddenDimDefault = hasGpu ? 128 : 64;
    const hiddenDimMax = hasGpu ? 256 : 128;
    const numLayersDefault = hasGpu ? 4 : 2;
    const numLayersMax = hasGpu ? 8 : 4;
    const numHeadsDefault = hasGpu ? 4 : 2;
    const warmupDefault = hasGpu ? 100 : 50;

    const clampHidden = (v: number): number => {
      const allowed = (hasGpu ? [64, 128, 192, 256] : [64, 128]).filter(d => d <= hiddenDimMax);
      return allowed.reduce((prev, curr) => Math.abs(curr - v) < Math.abs(prev - v) ? curr : prev);
    };

    const hyperparams: Hyperparams = {
      learningRate: this.clampValue(num(parsed.hyperparams?.learningRate, 0.001), 0.0001, 0.01),
      batchSize: this.clampToBatch(num(parsed.hyperparams?.batchSize, hasGpu ? 32 : 16)),
      hiddenDim: clampHidden(num(parsed.hyperparams?.hiddenDim, hiddenDimDefault)),
      numLayers: Math.round(this.clampValue(num(parsed.hyperparams?.numLayers, numLayersDefault), 2, numLayersMax)),
      numHeads: this.clampToHeads(num(parsed.hyperparams?.numHeads, numHeadsDefault)),
      activation: this.validateActivation(parsed.hyperparams?.activation),
      normalization: this.validateNormalization(parsed.hyperparams?.normalization),
      initScheme: this.validateInitScheme(parsed.hyperparams?.initScheme),
      warmupSteps: Math.round(this.clampValue(num(parsed.hyperparams?.warmupSteps, warmupDefault), 0, 1000)),
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
