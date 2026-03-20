import { Injectable } from '@nestjs/common';
import {
  startAgentLoop,
  stopAgentLoop,
  runAgentIteration,
  getAgentLoopState,
  resetAgentLoopState,
  fetchTopExperiments,
  createExperiment,
  updateExperiment,
  postToFeed,
  type AgentLoopConfig,
  type AgentLoopState,
  type AgentIterationResult,
} from '../../agent-loop.js';
import type { MutationProposal } from '../../mutation-engine.js';
import type { TrainingResult } from '../../trainer.js';
import type { Experiment } from '../../types.js';

@Injectable()
export class AgentLoopService {
  start(config: AgentLoopConfig): Promise<void> {
    return startAgentLoop(config);
  }

  stop(): void {
    return stopAgentLoop();
  }

  runIteration(config: AgentLoopConfig, iteration: number): Promise<AgentIterationResult> {
    return runAgentIteration(config, iteration);
  }

  getState(): AgentLoopState {
    return getAgentLoopState();
  }

  resetState(): void {
    return resetAgentLoopState();
  }

  fetchTopExperiments(coordinatorUrl: string, limit?: number): Promise<Experiment[]> {
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
    result: TrainingResult,
  ): Promise<void> {
    return updateExperiment(coordinatorUrl, experimentId, result);
  }

  postToFeed(
    coordinatorUrl: string,
    peerId: string,
    mutation: MutationProposal,
    result: TrainingResult,
    improved: boolean,
  ): Promise<void> {
    return postToFeed(coordinatorUrl, peerId, mutation, result, improved);
  }
}
