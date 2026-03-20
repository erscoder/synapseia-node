import { Injectable } from '@nestjs/common';
import { AgentLoopHelper, type AgentLoopConfig, type AgentLoopState, type AgentIterationResult } from './helpers/agent-loop.js';
import type { MutationProposal } from '../model/helpers/mutation-engine.js';
import type { TrainingResult } from '../model/helpers/trainer.js';
import type { Experiment } from '../../types.js';

@Injectable()
export class AgentLoopService {
  constructor(private readonly agentLoopHelper: AgentLoopHelper) {}

  start(config: AgentLoopConfig): Promise<void> {
    return this.agentLoopHelper.startAgentLoop(config);
  }

  stop(): void {
    return this.agentLoopHelper.stopAgentLoop();
  }

  runIteration(config: AgentLoopConfig, iteration: number): Promise<AgentIterationResult> {
    return this.agentLoopHelper.runAgentIteration(config, iteration);
  }

  getState(): AgentLoopState {
    return this.agentLoopHelper.getAgentLoopState();
  }

  resetState(): void {
    return this.agentLoopHelper.resetAgentLoopState();
  }

  fetchTopExperiments(coordinatorUrl: string, limit?: number): Promise<Experiment[]> {
    return this.agentLoopHelper.fetchTopExperiments(coordinatorUrl, limit);
  }

  createExperiment(
    coordinatorUrl: string,
    proposal: MutationProposal,
    peerId: string,
    tier: number,
  ): Promise<string> {
    return this.agentLoopHelper.createExperiment(coordinatorUrl, proposal, peerId, tier);
  }

  updateExperiment(
    coordinatorUrl: string,
    experimentId: string,
    result: TrainingResult,
  ): Promise<void> {
    return this.agentLoopHelper.updateExperiment(coordinatorUrl, experimentId, result);
  }

  postToFeed(
    coordinatorUrl: string,
    peerId: string,
    mutation: MutationProposal,
    result: TrainingResult,
    improved: boolean,
  ): Promise<void> {
    return this.agentLoopHelper.postToFeed(coordinatorUrl, peerId, mutation, result, improved);
  }
}
