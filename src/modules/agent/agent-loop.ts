/**
 * Agent Loop - Autonomous research loop for Synapseia
 *
 * Loop principal:
 * 1. Fetch top experiments from coordinator
 * 2. Propose mutation via LLM
 * 3. Train micro-model
 * 4. Publish result to coordinator
 * 5. Sleep and repeat
 */

import { Injectable } from '@nestjs/common';
import logger from '../../utils/logger';
import { MutationEngineHelper, type MutationProposal } from '../model/mutation-engine';
import { trainMicroModel, validateTrainingConfig, type TrainingResult } from '../model/trainer';
import type { Experiment } from '../../types';

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


@Injectable()
export class AgentLoopHelper {
  private state: AgentLoopState = {
    iteration: 0,
    bestLoss: Infinity,
    totalExperiments: 0,
    isRunning: false,
  };

  getAgentLoopState(): AgentLoopState {
    return { ...this.state };
  }

  resetAgentLoopState(): void {
    this.state = {
      iteration: 0,
      bestLoss: Infinity,
      totalExperiments: 0,
      isRunning: false,
    };
  }

  async fetchTopExperiments(coordinatorUrl: string, limit = 5): Promise<Experiment[]> {
    try {
      const response = await fetch(`${coordinatorUrl}/experiments?limit=${limit}&status=completed`);
      if (!response.ok) throw new Error(`Failed to fetch experiments: ${response.statusText}`);
      const data = await response.json() as { experiments: Experiment[] };
      return (data.experiments || [])
        .filter((exp: Experiment) => exp.valLoss !== null && exp.valLoss !== undefined)
        .sort((a: Experiment, b: Experiment) => (a.valLoss ?? Infinity) - (b.valLoss ?? Infinity))
        .slice(0, limit);
    } catch (error) {
      logger.warn('Failed to fetch experiments:', (error as Error).message);
      return [];
    }
  }

  async createExperiment(
    coordinatorUrl: string,
    proposal: MutationProposal,
    peerId: string,
    tier: number,
  ): Promise<string> {
    try {
      const response = await fetch(`${coordinatorUrl}/experiments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'micro-transformer-120k', hyperparams: proposal.hyperparams, tier }),
      });
      if (!response.ok) throw new Error(`Failed to create experiment: ${response.statusText}`);
      const data = await response.json() as { experiment: { id: string } };
      return data.experiment.id;
    } catch (error) {
      throw new Error(`Failed to create experiment: ${(error as Error).message}`);
    }
  }

  async updateExperiment(
    coordinatorUrl: string,
    experimentId: string,
    result: TrainingResult,
  ): Promise<void> {
    try {
      const response = await fetch(`${coordinatorUrl}/experiments/${experimentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', progress: 100, valLoss: result.valLoss }),
      });
      if (!response.ok) throw new Error(`Failed to update experiment: ${response.statusText}`);
    } catch (error) {
      logger.error('Failed to update experiment:', (error as Error).message);
      throw error;
    }
  }

  async runAgentIteration(config: AgentLoopConfig, iteration: number): Promise<AgentIterationResult> {
    const { coordinatorUrl, peerId, capabilities, datasetPath } = config;

    logger.log(`\n🔄 Iteration ${iteration} starting...`);

    logger.log('📥 Fetching top experiments...');
    const topExperiments = await this.fetchTopExperiments(coordinatorUrl);
    logger.log(`   Found ${topExperiments.length} experiments`);

    if (topExperiments.length > 0 && topExperiments[0].valLoss) {
      this.state.bestLoss = Math.min(this.state.bestLoss, topExperiments[0].valLoss);
    }
    const bestLossSafe = typeof this.state.bestLoss === 'number' && Number.isFinite(this.state.bestLoss)
      ? this.state.bestLoss
      : 0;
    logger.log(`   Best loss so far: ${bestLossSafe.toFixed(4)}`);

    logger.log('🧠 Proposing mutation via LLM...');
    const mutationEngine = new MutationEngineHelper();
    const mutation = await mutationEngine.proposeMutation(topExperiments, this.state.bestLoss, capabilities);
    logger.log(`   Type: ${mutation.type}`);
    logger.log(`   Reasoning: ${mutation.reasoning.slice(0, 100)}...`);

    const validation = validateTrainingConfig(mutation);
    if (!validation.valid) throw new Error(`Invalid training config: ${validation.error}`);

    logger.log('📝 Creating experiment...');
    const tier = capabilities.includes('gpu') ? 2 : 0;
    const experimentId = await this.createExperiment(coordinatorUrl, mutation, peerId, tier);
    logger.log(`   Experiment ID: ${experimentId}`);

    logger.log('🚀 Training micro-model...');
    const hardware = capabilities.includes('gpu') ? 'gpu' : 'cpu';
    const trainingResult = await trainMicroModel({
      proposal: mutation,
      datasetPath,
      hardware,
      runNumber: iteration,
    });

    const valLossSafe = typeof trainingResult.valLoss === 'number' && Number.isFinite(trainingResult.valLoss)
      ? trainingResult.valLoss
      : 0;
    logger.log(`   Training complete: ${valLossSafe.toFixed(4)} loss`);
    logger.log(`   Duration: ${trainingResult.durationMs}ms`);
    logger.log(`   Steps: ${trainingResult.lossCurve.length * 10}`);

    logger.log('💾 Updating experiment...');
    await this.updateExperiment(coordinatorUrl, experimentId, trainingResult);

    const improved = valLossSafe < this.state.bestLoss;
    if (improved) {
      this.state.bestLoss = valLossSafe;
      logger.log(`🎉 New best loss: ${this.state.bestLoss.toFixed(4)}!`);
    }

    if (improved) logger.log(`[AgentLoop] Iteration ${iteration}: improved → valLoss=${valLossSafe.toFixed(4)}`);

    this.state.iteration = iteration;
    this.state.totalExperiments++;

    return { iteration, mutation, trainingResult, experimentId, improved };
  }

  async startAgentLoop(config: AgentLoopConfig): Promise<void> {
    if (this.state.isRunning) throw new Error('Agent loop is already running');

    this.state.isRunning = true;
    const { intervalMs, maxIterations } = config;

    logger.log('🚀 Starting Synapseia Agent Loop');
    logger.log(`   Coordinator: ${config.coordinatorUrl}`);
    logger.log(`   Peer ID: ${config.peerId}`);
    logger.log(`   Capabilities: ${config.capabilities.join(', ')}`);
    logger.log(`   Interval: ${intervalMs}ms`);
    if (maxIterations) logger.log(`   Max iterations: ${maxIterations}`);

    try {
      let iteration = 1;
      while (this.state.isRunning) {
        if (maxIterations && iteration > maxIterations) {
          logger.log(`\n✅ Reached max iterations (${maxIterations}), stopping.`);
          break;
        }
        try {
          await this.runAgentIteration(config, iteration);
        } catch (error) {
          logger.error(`❌ Iteration ${iteration} failed:`, (error as Error).message);
        }
        if (this.state.isRunning) {
          logger.log(`⏳ Sleeping for ${intervalMs}ms...`);
          await this.sleep(intervalMs);
        }
        iteration++;
      }
    } finally {
      this.state.isRunning = false;
      logger.log('\n🛑 Agent loop stopped');
    }
  }

  stopAgentLoop(): void {
    this.state.isRunning = false;
    logger.log('🛑 Stopping agent loop...');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
