import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { TrainerService } from '../trainer.service';
import { TrainerHelper } from '../../trainer';

const mockProposal = {
  mutationType: 'learning_rate',
  parameters: { lr: 0.001 },
  reasoning: 'try lower lr',
};

describe('TrainerService', () => {
  let service: TrainerService;
  let trainerHelper: jest.Mocked<TrainerHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrainerService,
        {
          provide: TrainerHelper,
          useValue: {
            trainMicroModel: jest.fn(),
            validateTrainingConfig: jest.fn(),
            calculateImprovement: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TrainerService>(TrainerService);
    trainerHelper = module.get(TrainerHelper);
  });

  it('train() delegates to trainMicroModel', async () => {
    const mockResult = { valLoss: 0.3, improved: true, modelPath: '/tmp/model' };
    const options = { proposal: mockProposal, dataPath: '/data', epochs: 5 };
    trainerHelper.trainMicroModel.mockResolvedValue(mockResult as any);

    const result = await service.train(options as any);

    expect(trainerHelper.trainMicroModel).toHaveBeenCalledWith(options);
    expect(result).toBe(mockResult);
  });

  it('validateConfig() delegates to validateTrainingConfig - valid', () => {
    trainerHelper.validateTrainingConfig.mockReturnValue({ valid: true });
    const result = service.validateConfig(mockProposal as any);
    expect(trainerHelper.validateTrainingConfig).toHaveBeenCalledWith(mockProposal);
    expect(result).toEqual({ valid: true });
  });

  it('validateConfig() delegates to validateTrainingConfig - invalid', () => {
    trainerHelper.validateTrainingConfig.mockReturnValue({ valid: false, error: 'bad config' });
    const result = service.validateConfig(mockProposal as any);
    expect(result).toEqual({ valid: false, error: 'bad config' });
  });

  it('calculateImprovement() delegates to calculateImprovement', () => {
    trainerHelper.calculateImprovement.mockReturnValue(0.15);
    const result = service.calculateImprovement(0.35, 0.5);
    expect(trainerHelper.calculateImprovement).toHaveBeenCalledWith(0.35, 0.5);
    expect(result).toBe(0.15);
  });

  it('calculateImprovement() returns 0 when no improvement', () => {
    trainerHelper.calculateImprovement.mockReturnValue(0);
    const result = service.calculateImprovement(0.6, 0.5);
    expect(result).toBe(0);
  });
});
