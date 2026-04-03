/**
 * Type definitions for Synapseia agent runtime
 */

export interface Experiment {
  id: string;
  model: string;
  hyperparams: Hyperparams;
  valLoss: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt?: number;
  completedAt?: number;
}

export interface Hyperparams {
  learningRate: number;
  batchSize: number;
  hiddenDim: number;
  numLayers: number;
  numHeads: number;
  activation: 'gelu' | 'silu' | 'relu';
  normalization: 'layernorm' | 'rmsnorm';
  initScheme: 'xavier' | 'kaiming' | 'normal';
  warmupSteps: number;  // Fixed: was "warmup steps"
  weightDecay: number;
  maxTrainSeconds: number;
}
