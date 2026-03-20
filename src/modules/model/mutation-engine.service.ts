import { Injectable } from '@nestjs/common';
import { proposeMutation, type MutationProposal } from '../../mutation-engine.js';
import type { Experiment } from '../../types.js';

@Injectable()
export class MutationEngineService {
  propose(
    topExperiments: Experiment[],
    bestLoss: number,
    capabilities: string[],
  ): Promise<MutationProposal> {
    return proposeMutation(topExperiments, bestLoss, capabilities);
  }
}
