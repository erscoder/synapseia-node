import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { MutationEngineService } from '../mutation-engine.service.js';
import { MutationEngineHelper } from '../../../mutation-engine.js';

describe('MutationEngineService', () => {
  let service: MutationEngineService;
  let mutationEngineHelper: jest.Mocked<MutationEngineHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MutationEngineService,
        {
          provide: MutationEngineHelper,
          useValue: {
            proposeMutation: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MutationEngineService>(MutationEngineService);
    mutationEngineHelper = module.get(MutationEngineHelper);
  });

  it('propose() delegates to proposeMutation', async () => {
    const mockProposal = {
      mutationType: 'learning_rate',
      parameters: { lr: 0.001 },
      reasoning: 'try lower lr',
    };
    const experiments = [
      { id: 'exp-1', loss: 0.5, params: {} },
    ];
    mutationEngineHelper.proposeMutation.mockResolvedValue(mockProposal as any);

    const result = await service.propose(experiments as any, 0.5, ['cpu']);

    expect(mutationEngineHelper.proposeMutation).toHaveBeenCalledWith(experiments, 0.5, ['cpu']);
    expect(result).toBe(mockProposal);
  });

  it('propose() passes capabilities array', async () => {
    const mockProposal = { mutationType: 'batch_size', parameters: {}, reasoning: '' };
    mutationEngineHelper.proposeMutation.mockResolvedValue(mockProposal as any);

    await service.propose([], 1.0, ['cpu', 'inference', 'embedding']);

    expect(mutationEngineHelper.proposeMutation).toHaveBeenCalledWith([], 1.0, ['cpu', 'inference', 'embedding']);
  });
});
