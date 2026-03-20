import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../staking.js', () => ({
  verifyStake: jest.fn(),
  getMinimumStake: jest.fn(),
  computeTier: jest.fn(),
  meetsMinimumStake: jest.fn(),
  getAllStakesForPeer: jest.fn(),
  getTotalNetworkStake: jest.fn(),
}));

import * as stakingHelper from '../../../staking.js';
import { StakingService } from '../staking.service.js';

describe('StakingService', () => {
  let service: StakingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StakingService();
  });

  it('verify() delegates to verifyStake without rpcUrl', async () => {
    const mockResult = { valid: true, stakeInfo: { stakedAmount: 100 } };
    (stakingHelper.verifyStake as jest.Mock<any>).mockResolvedValue(mockResult);
    const result = await service.verify('peer-1');
    expect(stakingHelper.verifyStake).toHaveBeenCalledWith('peer-1', undefined);
    expect(result).toBe(mockResult);
  });

  it('verify() delegates to verifyStake with rpcUrl', async () => {
    const mockResult = { valid: false };
    (stakingHelper.verifyStake as jest.Mock<any>).mockResolvedValue(mockResult);
    await service.verify('peer-1', 'https://rpc.solana.com');
    expect(stakingHelper.verifyStake).toHaveBeenCalledWith('peer-1', 'https://rpc.solana.com');
  });

  it('getMinimumStake() delegates to getMinimumStake', () => {
    (stakingHelper.getMinimumStake as jest.Mock<any>).mockReturnValue(100);
    const result = service.getMinimumStake(1);
    expect(stakingHelper.getMinimumStake).toHaveBeenCalledWith(1);
    expect(result).toBe(100);
  });

  it('computeTier() delegates to computeTier', () => {
    (stakingHelper.computeTier as jest.Mock<any>).mockReturnValue(2);
    const result = service.computeTier(500);
    expect(stakingHelper.computeTier).toHaveBeenCalledWith(500);
    expect(result).toBe(2);
  });

  it('meetsMinimum() delegates to meetsMinimumStake - true', () => {
    (stakingHelper.meetsMinimumStake as jest.Mock<any>).mockReturnValue(true);
    const result = service.meetsMinimum(200, 1);
    expect(stakingHelper.meetsMinimumStake).toHaveBeenCalledWith(200, 1);
    expect(result).toBe(true);
  });

  it('meetsMinimum() delegates to meetsMinimumStake - false', () => {
    (stakingHelper.meetsMinimumStake as jest.Mock<any>).mockReturnValue(false);
    const result = service.meetsMinimum(10, 3);
    expect(result).toBe(false);
  });

  it('getAllForPeer() delegates to getAllStakesForPeer', async () => {
    const stakes = [{ stakedAmount: 100, lockExpiry: 999 }];
    (stakingHelper.getAllStakesForPeer as jest.Mock<any>).mockResolvedValue(stakes);
    const result = await service.getAllForPeer('peer-1');
    expect(stakingHelper.getAllStakesForPeer).toHaveBeenCalledWith('peer-1', undefined);
    expect(result).toBe(stakes);
  });

  it('getAllForPeer() passes rpcUrl', async () => {
    (stakingHelper.getAllStakesForPeer as jest.Mock<any>).mockResolvedValue([]);
    await service.getAllForPeer('peer-1', 'https://rpc.solana.com');
    expect(stakingHelper.getAllStakesForPeer).toHaveBeenCalledWith('peer-1', 'https://rpc.solana.com');
  });

  it('getTotalNetworkStake() delegates without rpcUrl', async () => {
    (stakingHelper.getTotalNetworkStake as jest.Mock<any>).mockResolvedValue(50000);
    const result = await service.getTotalNetworkStake();
    expect(stakingHelper.getTotalNetworkStake).toHaveBeenCalledWith(undefined);
    expect(result).toBe(50000);
  });

  it('getTotalNetworkStake() passes rpcUrl', async () => {
    (stakingHelper.getTotalNetworkStake as jest.Mock<any>).mockResolvedValue(99999);
    await service.getTotalNetworkStake('https://rpc.solana.com');
    expect(stakingHelper.getTotalNetworkStake).toHaveBeenCalledWith('https://rpc.solana.com');
  });
});
