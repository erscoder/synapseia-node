import { Injectable } from '@nestjs/common';
import {
  trainMicroModel,
  validateTrainingConfig,
  calculateImprovement,
  type TrainingResult,
  type TrainingOptions,
} from '../../trainer.js';
import type { MutationProposal } from '../../mutation-engine.js';

@Injectable()
export class TrainerService {
  train(options: TrainingOptions): Promise<TrainingResult> {
    return trainMicroModel(options);
  }

  validateConfig(proposal: MutationProposal): { valid: boolean; error?: string } {
    return validateTrainingConfig(proposal);
  }

  calculateImprovement(currentLoss: number, bestLoss: number): number {
    return calculateImprovement(currentLoss, bestLoss);
  }
}
