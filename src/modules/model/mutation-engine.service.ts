import { Injectable } from '@nestjs/common';
import { MutationEngineHelper, type MutationProposal } from '../../mutation-engine.js';
import type { Experiment } from '../../types.js';

@Injectable()
export class MutationEngineService {
  constructor(private readonly mutationEngineHelper: MutationEngineHelper) {}

  propose(
    topExperiments: Experiment[],
    bestLoss: number,
    capabilities: string[],
  ): Promise<MutationProposal> {
    return this.mutationEngineHelper.proposeMutation(topExperiments, bestLoss, capabilities);
  }
}
