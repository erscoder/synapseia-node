import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../trainer.js', () => ({
  trainMicroModel: jest.fn(),
  validateTrainingConfig: jest.fn(),
  calculateImprovement: jest.fn(),
}));

import * as trainerHelper from '../../../trainer.js';
import { TrainerService } from '../trainer.service.js';

const mockProposal = {
  mutationType: 'learning_rate',
  parameters: { lr: 0.001 },
  reasoning: 'try lower lr',
};

describe('TrainerService', () => {
  let service: TrainerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TrainerService();
  });

  it('train() delegates to trainMicroModel', async () => {
    const mockResult = { valLoss: 0.3, improved: true, modelPath: '/tmp/model' };
    const options = { proposal: mockProposal, dataPath: '/data', epochs: 5 };
    (trainerHelper.trainMicroModel as jest.Mock<any>).mockResolvedValue(mockResult);

    const result = await service.train(options as any);

    expect(trainerHelper.trainMicroModel).toHaveBeenCalledWith(options);
    expect(result).toBe(mockResult);
  });

  it('validateConfig() delegates to validateTrainingConfig - valid', () => {
    (trainerHelper.validateTrainingConfig as jest.Mock<any>).mockReturnValue({ valid: true });
    const result = service.validateConfig(mockProposal as any);
    expect(trainerHelper.validateTrainingConfig).toHaveBeenCalledWith(mockProposal);
    expect(result).toEqual({ valid: true });
  });

  it('validateConfig() delegates to validateTrainingConfig - invalid', () => {
    (trainerHelper.validateTrainingConfig as jest.Mock<any>).mockReturnValue({ valid: false, error: 'bad config' });
    const result = service.validateConfig(mockProposal as any);
    expect(result).toEqual({ valid: false, error: 'bad config' });
  });

  it('calculateImprovement() delegates to calculateImprovement', () => {
    (trainerHelper.calculateImprovement as jest.Mock<any>).mockReturnValue(0.15);
    const result = service.calculateImprovement(0.35, 0.5);
    expect(trainerHelper.calculateImprovement).toHaveBeenCalledWith(0.35, 0.5);
    expect(result).toBe(0.15);
  });

  it('calculateImprovement() returns 0 when no improvement', () => {
    (trainerHelper.calculateImprovement as jest.Mock<any>).mockReturnValue(0);
    const result = service.calculateImprovement(0.6, 0.5);
    expect(result).toBe(0);
  });
});
