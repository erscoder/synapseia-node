/**
 * Mutation Engine - LLM-powered hyperparameter mutation
 */

import { Injectable } from '@nestjs/common';
import { LlmProviderHelper, type LLMModel } from '../llm/llm-provider';
import type { Experiment, Hyperparams } from '../../types';

export interface MutationProposal {
  model: LLMModel;
  type: 'explore' | 'improve';
  baseExperimentId: string | null;
  hyperparams: Hyperparams;
  reasoning: string;
  estimatedCost?: number;
}

@Injectable()
export class MutationEngineHelper {
  private readonly llmProvider = new LlmProviderHelper();

  async proposeMutation(
    topExperiments: Experiment[],
    bestLoss: number,
    capabilities: string[],
  ): Promise<MutationProposal> {
    if (topExperiments.length === 0) {
      return this.defaultMutation(capabilities, 'Starting with default configuration for initial exploration');
    }

    const prompt = this.buildPrompt(topExperiments, bestLoss, capabilities);
    const model: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };
    try {
      const response = await this.llmProvider.generateLLM(model, prompt);
      return this.parseMutationResponse(response, topExperiments, bestLoss, capabilities);
    } catch (err) {
      // Small local models (qwen2.5:0.5b) frequently produce malformed JSON. Don't fail
      // the whole training WO — fall back to a safe default config and move on.
      const msg = err instanceof Error ? err.message : String(err);
      return this.defaultMutation(capabilities, `LLM mutation parse failed (${msg.slice(0, 100)}), using default config`);
    }
  }

  private defaultMutation(capabilities: string[], reasoning: string): MutationProposal {
    return {
      model: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
      type: 'explore',
      baseExperimentId: null,
      hyperparams: {
        learningRate: 0.001, batchSize: 32, hiddenDim: 128, numLayers: 4,
        numHeads: 4, activation: 'gelu', normalization: 'layernorm',
        initScheme: 'xavier', warmupSteps: 100, weightDecay: 0.01,
        maxTrainSeconds: capabilities.includes('gpu') ? 300 : 120,
      },
      reasoning,
    };
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
    "maxTrainSeconds": ${hasGpu ? 300 : 120}
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
  ): MutationProposal {
    const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse JSON from LLM response');

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr) as any;

    const hyperparams: Hyperparams = {
      learningRate: this.clampValue(parsed.hyperparams?.learningRate ?? 0.001, 0.0001, 0.01),
      batchSize: this.clampToBatch(parsed.hyperparams?.batchSize ?? 32),
      hiddenDim: this.clampToDimension(parsed.hyperparams?.hiddenDim ?? 128),
      numLayers: this.clampValue(parsed.hyperparams?.numLayers ?? 4, 2, 8),
      numHeads: this.clampToHeads(parsed.hyperparams?.numHeads ?? 4),
      activation: this.validateActivation(parsed.hyperparams?.activation),
      normalization: this.validateNormalization(parsed.hyperparams?.normalization),
      initScheme: this.validateInitScheme(parsed.hyperparams?.initScheme),
      warmupSteps: this.clampValue(parsed.hyperparams?.warmupSteps ?? 100, 0, 1000),
      weightDecay: this.clampValue(parsed.hyperparams?.weightDecay ?? 0.01, 0, 0.1),
      maxTrainSeconds: capabilities.includes('gpu')
        ? this.clampValue(parsed.hyperparams?.maxTrainSeconds ?? 300, 120, 600)
        : this.clampValue(parsed.hyperparams?.maxTrainSeconds ?? 120, 60, 300),
    };

    return {
      model: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
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
