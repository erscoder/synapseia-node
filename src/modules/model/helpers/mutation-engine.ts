/**
 * Mutation Engine - LLM-powered hyperparameter mutation
 * The LLM proposes optimizations based on what worked in the network
 */

import { Injectable } from '@nestjs/common';
import { generateLLM, type LLMModel } from '../../llm/helpers/llm-provider.js';
import type { Experiment, Hyperparams } from '../../../types.js';

export interface MutationProposal {
  model: LLMModel;
  type: 'explore' | 'improve';
  baseExperimentId: string | null;
  hyperparams: Hyperparams;
  reasoning: string;
  estimatedCost?: number;
}

/**
 * Propose a new hyperparameter configuration based on top experiments
 * @param topExperiments - Top 5 experiments from the network
 * @param bestLoss - Best loss seen so far
 * @param capabilities - Hardware capabilities: ['cpu'] or ['cpu', 'gpu']
 * @returns MutationProposal with new hyperparams and reasoning
 */
export async function proposeMutation(
  topExperiments: Experiment[],
  bestLoss: number,
  capabilities: string[]
): Promise<MutationProposal> {
  if (topExperiments.length === 0) {
    // Default mutation when no experiments exist
    return {
      model: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
      type: 'explore',
      baseExperimentId: null,
      hyperparams: {
        learningRate: 0.001,
        batchSize: 32,
        hiddenDim: 128,
        numLayers: 4,
        numHeads: 4,
        activation: 'gelu',
        normalization: 'layernorm',
        initScheme: 'xavier',
        warmupSteps: 100,
        weightDecay: 0.01,
        maxTrainSeconds: capabilities.includes('gpu') ? 300 : 120,
      },
      reasoning: 'Starting with default configuration for initial exploration',
    };
  }

  const prompt = buildPrompt(topExperiments, bestLoss, capabilities);
  const model: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };

  const response = await generateLLM(model, prompt);

  return parseMutationResponse(response, topExperiments, bestLoss, capabilities);
}

function buildPrompt(
  topExperiments: Experiment[],
  bestLoss: number,
  capabilities: string[]
): string {
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
    "learningRate": 0.001,
    "batchSize": 32,
    "hiddenDim": 128,
    "numLayers": 4,
    "numHeads": 4,
    "activation": "gelu" or "silu" or "relu",
    "normalization": "layernorm" or "rmsnorm",
    "initScheme": "xavier" or "kaiming" or "normal",
    "warmupSteps": 100,
    "weightDecay": 0.01,
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

/**
 * Parse LLM response and validate/clamp hyperparameters
 */
function parseMutationResponse(
  response: string,
  topExperiments: Experiment[],
  bestLoss: number,
  capabilities: string[]
): MutationProposal {
  // Extract JSON from response (may be wrapped in markdown)
  const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) ||
                     response.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error('Failed to parse JSON from LLM response');
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  const parsed = JSON.parse(jsonStr) as any;

  // Validate and clamp hyperparams
  const hyperparams: Hyperparams = {
    learningRate: clampValue(parsed.hyperparams?.learningRate ?? 0.001, 0.0001, 0.01),
    batchSize: clampValueToBatch(parsed.hyperparams?.batchSize ?? 32),
    hiddenDim: clampToDimension(parsed.hyperparams?.hiddenDim ?? 128),
    numLayers: clampValue(parsed.hyperparams?.numLayers ?? 4, 2, 8),
    numHeads: clampToHeads(parsed.hyperparams?.numHeads ?? 4),
    activation: validateActivation(parsed.hyperparams?.activation),
    normalization: validateNormalization(parsed.hyperparams?.normalization),
    initScheme: validateInitScheme(parsed.hyperparams?.initScheme),
    warmupSteps: clampValue(parsed.hyperparams?.warmupSteps ?? 100, 0, 1000),
    weightDecay: clampValue(parsed.hyperparams?.weightDecay ?? 0.01, 0, 0.1),
    maxTrainSeconds: capabilities.includes('gpu') ?
      clampValue(parsed.hyperparams?.maxTrainSeconds ?? 300, 120, 600) :
      clampValue(parsed.hyperparams?.maxTrainSeconds ?? 120, 60, 300),
  };

  const model: LLMModel = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };

  return {
    model,
    type: parsed.type === 'explore' || parsed.type === 'improve' ? parsed.type : 'explore',
    baseExperimentId: parsed.baseExperimentId || null,
    hyperparams,
    reasoning: parsed.reasoning || 'Proposed mutation',
  };
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampValueToBatch(value: number): number {
  const validBatchSizes = [16, 32, 64, 128];
  const closest = validBatchSizes.reduce((prev, curr) =>
    Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
  );
  return closest;
}

function clampToDimension(value: number): number {
  const validDims = [64, 128, 192, 256];
  const closest = validDims.reduce((prev, curr) =>
    Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
  );
  return closest;
}

function clampToHeads(value: number): number {
  const validHeads = [2, 4, 8];
  const closest = validHeads.reduce((prev, curr) =>
    Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
  );
  return closest;
}

function validateActivation(value: any): 'gelu' | 'silu' | 'relu' {
  const valid = ['gelu', 'silu', 'relu'];
  return valid.includes(value) ? value : 'gelu';
}

function validateNormalization(value: any): 'layernorm' | 'rmsnorm' {
  const valid = ['layernorm', 'rmsnorm'];
  return valid.includes(value) ? value : 'layernorm';
}

function validateInitScheme(value: any): 'xavier' | 'kaiming' | 'normal' {
  const valid = ['xavier', 'kaiming', 'normal'];
  return valid.includes(value) ? value : 'xavier';
}

export const _test = {
  buildPrompt,
  parseMutationResponse,
  clampValue,
  clampBatchSize: clampValueToBatch,
};

/**
 * Injectable helper class — wraps mutation engine functions for NestJS DI
 */
@Injectable()
export class MutationEngineHelper {
  proposeMutation(
    topExperiments: Experiment[],
    bestLoss: number,
    capabilities: string[],
  ): Promise<MutationProposal> {
    return proposeMutation(topExperiments, bestLoss, capabilities);
  }
}
