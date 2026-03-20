import { Injectable } from '@nestjs/common';
import {
  TrainerHelper,
  type TrainingResult,
  type TrainingOptions,
} from './helpers/trainer.js';
import type { MutationProposal } from './helpers/mutation-engine.js';

@Injectable()
export class TrainerService {
  constructor(private readonly trainerHelper: TrainerHelper) {}

  train(options: TrainingOptions): Promise<TrainingResult> {
    return this.trainerHelper.trainMicroModel(options);
  }

  validateConfig(proposal: MutationProposal): { valid: boolean; error?: string } {
    return this.trainerHelper.validateTrainingConfig(proposal);
  }

  calculateImprovement(currentLoss: number, bestLoss: number): number {
    return this.trainerHelper.calculateImprovement(currentLoss, bestLoss);
  }
}
