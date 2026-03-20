import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../mutation-engine.js', () => ({
  proposeMutation: jest.fn(),
}));

import * as mutationHelper from '../../../mutation-engine.js';
import { MutationEngineService } from '../mutation-engine.service.js';

describe('MutationEngineService', () => {
  let service: MutationEngineService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MutationEngineService();
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
    (mutationHelper.proposeMutation as jest.Mock<any>).mockResolvedValue(mockProposal);

    const result = await service.propose(experiments as any, 0.5, ['cpu']);

    expect(mutationHelper.proposeMutation).toHaveBeenCalledWith(experiments, 0.5, ['cpu']);
    expect(result).toBe(mockProposal);
  });

  it('propose() passes capabilities array', async () => {
    const mockProposal = { mutationType: 'batch_size', parameters: {}, reasoning: '' };
    (mutationHelper.proposeMutation as jest.Mock<any>).mockResolvedValue(mockProposal);

    await service.propose([], 1.0, ['cpu', 'inference', 'embedding']);

    expect(mutationHelper.proposeMutation).toHaveBeenCalledWith([], 1.0, ['cpu', 'inference', 'embedding']);
  });
});
