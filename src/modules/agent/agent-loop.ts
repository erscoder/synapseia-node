/**
 * Agent Loop - Autonomous research loop for SynapseIA
 *
 * Loop principal:
 * 1. Fetch top experiments from coordinator
 * 2. Propose mutation via LLM
 * 3. Train micro-model
 * 4. Publish result to coordinator
 * 5. Sleep and repeat
 */

import { Injectable } from '@nestjs/common';
import logger from '../../utils/logger.js';
import { proposeMutation, type MutationProposal } from '../model/mutation-engine.js';
import { trainMicroModel, validateTrainingConfig, calculateImprovement, type TrainingResult } from '../model/trainer.js';
import type { Experiment } from '../../types.js';

export interface AgentLoopConfig {
  coordinatorUrl: string;
  peerId: string;
  capabilities: string[];
  intervalMs: number;
  datasetPath: string;
  maxIterations?: number;
}

export interface AgentIterationResult {
  iteration: number;
  mutation: MutationProposal;
  trainingResult: TrainingResult;
  experimentId: string;
  improved: boolean;
}

export interface AgentLoopState {
  iteration: number;
  bestLoss: number;
  totalExperiments: number;
  isRunning: boolean;
}

// Global state for the agent loop
let loopState: AgentLoopState = {
  iteration: 0,
  bestLoss: Infinity,
  totalExperiments: 0,
  isRunning: false,
};

/**
 * Get current agent loop state
 */
export function getAgentLoopState(): AgentLoopState {
  return { ...loopState };
}

/**
 * Reset agent loop state
 */
export function resetAgentLoopState(): void {
  loopState = {
    iteration: 0,
    bestLoss: Infinity,
    totalExperiments: 0,
    isRunning: false,
  };
}

/**
 * Fetch top experiments from coordinator
 */
export async function fetchTopExperiments(
  coordinatorUrl: string,
  limit: number = 5
): Promise<Experiment[]> {
  try {
    const response = await fetch(`${coordinatorUrl}/experiments?limit=${limit}&status=completed`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch experiments: ${response.statusText}`);
    }
    
    const data = await response.json() as { experiments: Experiment[] };
    
    // Sort by valLoss (lower is better)
    return (data.experiments || [])
      .filter((exp: Experiment) => exp.valLoss !== null && exp.valLoss !== undefined)
      .sort((a: Experiment, b: Experiment) => (a.valLoss ?? Infinity) - (b.valLoss ?? Infinity))
      .slice(0, limit);
  } catch (error) {
    logger.warn('Failed to fetch experiments:', (error as Error).message);
    return [];
  }
}

/**
 * Create experiment in coordinator
 */
export async function createExperiment(
  coordinatorUrl: string,
  proposal: MutationProposal,
  peerId: string,
  tier: number
): Promise<string> {
  try {
    const response = await fetch(`${coordinatorUrl}/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'micro-transformer-120k',
        hyperparams: proposal.hyperparams,
        tier,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create experiment: ${response.statusText}`);
    }
    
    const data = await response.json() as { experiment: { id: string } };
    return data.experiment.id;
  } catch (error) {
    throw new Error(`Failed to create experiment: ${(error as Error).message}`);
  }
}

/**
 * Update experiment with training results
 */
export async function updateExperiment(
  coordinatorUrl: string,
  experimentId: string,
  result: TrainingResult
): Promise<void> {
  try {
    const response = await fetch(`${coordinatorUrl}/experiments/${experimentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        progress: 100,
        valLoss: result.valLoss,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update experiment: ${response.statusText}`);
    }
  } catch (error) {
    logger.error('Failed to update experiment:', (error as Error).message);
    throw error;
  }
}

/**
 * Post discovery to feed
 */
export async function postToFeed(
  coordinatorUrl: string,
  peerId: string,
  mutation: MutationProposal,
  result: TrainingResult,
  improved: boolean
): Promise<void> {
  try {
    // Note: Feed endpoint needs to be implemented in coordinator
    // This is a placeholder for the feed integration
    logger.log(`[FEED] ${improved ? '🎉 IMPROVEMENT' : '📝 Result'}: ${mutation.type} - ${mutation.reasoning} (loss: ${result.valLoss.toFixed(4)})`);
  } catch (error) {
    logger.warn('Failed to post to feed:', (error as Error).message);
  }
}

/**
 * Run single iteration of the agent loop
 */
export async function runAgentIteration(
  config: AgentLoopConfig,
  iteration: number
): Promise<AgentIterationResult> {
  const { coordinatorUrl, peerId, capabilities, datasetPath } = config;
  
  logger.log(`\n🔄 Iteration ${iteration} starting...`);
  
  // 1. Fetch top experiments
  logger.log('📥 Fetching top experiments...');
  const topExperiments = await fetchTopExperiments(coordinatorUrl);
  logger.log(`   Found ${topExperiments.length} experiments`);
  
  // Update best loss
  if (topExperiments.length > 0 && topExperiments[0].valLoss) {
    loopState.bestLoss = Math.min(loopState.bestLoss, topExperiments[0].valLoss);
  }
  logger.log(`   Best loss so far: ${loopState.bestLoss.toFixed(4)}`);
  
  // 2. Propose mutation
  logger.log('🧠 Proposing mutation via LLM...');
  const mutation = await proposeMutation(topExperiments, loopState.bestLoss, capabilities);
  logger.log(`   Type: ${mutation.type}`);
  logger.log(`   Reasoning: ${mutation.reasoning.slice(0, 100)}...`);
  
  // Validate configuration
  const validation = validateTrainingConfig(mutation);
  if (!validation.valid) {
    throw new Error(`Invalid training config: ${validation.error}`);
  }
  
  // 3. Create experiment in coordinator
  logger.log('📝 Creating experiment...');
  const tier = capabilities.includes('gpu') ? 2 : 0;
  const experimentId = await createExperiment(coordinatorUrl, mutation, peerId, tier);
  logger.log(`   Experiment ID: ${experimentId}`);
  
  // 4. Train micro-model
  logger.log('🚀 Training micro-model...');
  const hardware = capabilities.includes('gpu') ? 'gpu' : 'cpu';
  const trainingResult = await trainMicroModel({
    proposal: mutation,
    datasetPath,
    hardware,
    runNumber: iteration,
  });
  
  logger.log(`   Training complete: ${trainingResult.valLoss.toFixed(4)} loss`);
  logger.log(`   Duration: ${trainingResult.durationMs}ms`);
  logger.log(`   Steps: ${trainingResult.lossCurve.length * 10}`);
  
  // 5. Update experiment with results
  logger.log('💾 Updating experiment...');
  await updateExperiment(coordinatorUrl, experimentId, trainingResult);
  
  // 6. Check if improved
  const improved = trainingResult.valLoss < loopState.bestLoss;
  if (improved) {
    loopState.bestLoss = trainingResult.valLoss;
    logger.log(`🎉 New best loss: ${loopState.bestLoss.toFixed(4)}!`);
  }
  
  // 7. Post to feed
  await postToFeed(coordinatorUrl, peerId, mutation, trainingResult, improved);
  
  loopState.iteration = iteration;
  loopState.totalExperiments++;
  
  return {
    iteration,
    mutation,
    trainingResult,
    experimentId,
    improved,
  };
}

/**
 * Start the autonomous agent loop
 */
export async function startAgentLoop(config: AgentLoopConfig): Promise<void> {
  if (loopState.isRunning) {
    throw new Error('Agent loop is already running');
  }
  
  loopState.isRunning = true;
  const { intervalMs, maxIterations } = config;
  
  logger.log('🚀 Starting SynapseIA Agent Loop');
  logger.log(`   Coordinator: ${config.coordinatorUrl}`);
  logger.log(`   Peer ID: ${config.peerId}`);
  logger.log(`   Capabilities: ${config.capabilities.join(', ')}`);
  logger.log(`   Interval: ${intervalMs}ms`);
  if (maxIterations) {
    logger.log(`   Max iterations: ${maxIterations}`);
  }
  logger.log('');
  
  try {
    let iteration = 1;
    
    while (loopState.isRunning) {
      // Check max iterations
      if (maxIterations && iteration > maxIterations) {
        logger.log(`\n✅ Reached max iterations (${maxIterations}), stopping.`);
        break;
      }
      
      try {
        await runAgentIteration(config, iteration);
      } catch (error) {
        logger.error(`❌ Iteration ${iteration} failed:`, (error as Error).message);
      }
      
      // Sleep before next iteration
      if (loopState.isRunning) {
        logger.log(`⏳ Sleeping for ${intervalMs}ms...`);
        await sleep(intervalMs);
      }
      
      iteration++;
    }
  } finally {
    loopState.isRunning = false;
    logger.log('\n🛑 Agent loop stopped');
  }
}

/**
 * Stop the agent loop
 */
export function stopAgentLoop(): void {
  loopState.isRunning = false;
  logger.log('🛑 Stopping agent loop...');
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Export for testing
export const _test = {
  fetchTopExperiments,
  createExperiment,
  updateExperiment,
  postToFeed,
  runAgentIteration,
  sleep,
};

// ---------------------------------------------------------------------------
// Injectable helper class — wraps the standalone functions for NestJS DI
// ---------------------------------------------------------------------------

@Injectable()
export class AgentLoopHelper {
  startAgentLoop(config: AgentLoopConfig): Promise<void> {
    return startAgentLoop(config);
  }

  stopAgentLoop(): void {
    return stopAgentLoop();
  }

  runAgentIteration(config: AgentLoopConfig, iteration: number): Promise<AgentIterationResult> {
    return runAgentIteration(config, iteration);
  }

  getAgentLoopState(): AgentLoopState {
    return getAgentLoopState();
  }

  resetAgentLoopState(): void {
    return resetAgentLoopState();
  }

  fetchTopExperiments(coordinatorUrl: string, limit?: number): Promise<import('../../types.js').Experiment[]> {
    return fetchTopExperiments(coordinatorUrl, limit);
  }

  createExperiment(
    coordinatorUrl: string,
    proposal: MutationProposal,
    peerId: string,
    tier: number,
  ): Promise<string> {
    return createExperiment(coordinatorUrl, proposal, peerId, tier);
  }

  updateExperiment(
    coordinatorUrl: string,
    experimentId: string,
    result: import('../model/trainer.js').TrainingResult,
  ): Promise<void> {
    return updateExperiment(coordinatorUrl, experimentId, result);
  }

  postToFeed(
    coordinatorUrl: string,
    peerId: string,
    mutation: MutationProposal,
    result: import('../model/trainer.js').TrainingResult,
    improved: boolean,
  ): Promise<void> {
    return postToFeed(coordinatorUrl, peerId, mutation, result, improved);
  }
}
