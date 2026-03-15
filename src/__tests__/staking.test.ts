/**
 * Staking verification tests (A11)
 */

import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

// Mock dependencies
const mockGetProgramAccounts = jest.fn() as any;
const mockGetAccountInfo = jest.fn() as any;
const mockConnection = {
  getProgramAccounts: mockGetProgramAccounts,
  getAccountInfo: mockGetAccountInfo,
};

jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn(() => mockConnection),
  PublicKey: class {
    constructor(public value: string) {}
    static findProgramAddressSync: jest.Mock = jest.fn(() => ['mock-address' as any, 0]);
  },
}));

describe('staking (A11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('verifyStake', () => {
    it('should verify existing stake account', async () => {
      const { verifyStake } = await import('../staking.js');

      // Mock 100 SYN staked (little-endian uint64)
      const stakeData = Buffer.alloc(24);
      stakeData.writeBigUInt64LE(100n, 0);
      mockGetAccountInfo.mockResolvedValue({ data: stakeData });

      const result = await verifyStake('peer-123');

      expect(result.valid).toBe(true);
      expect(result.stakeInfo?.stakedAmount).toBe(100);
      expect(result.stakeInfo?.tier).toBe(1); // 100 SYN → tier 1
    });

    it('should verify 500 SYN stake (tier 2)', async () => {
      const { verifyStake } = await import('../staking.js');

      const stakeData = Buffer.alloc(24);
      stakeData.writeBigUInt64LE(500n, 0);
      mockGetAccountInfo.mockResolvedValue({ data: stakeData });

      const result = await verifyStake('peer-456');

      expect(result.valid).toBe(true);
      expect(result.stakeInfo?.tier).toBe(2);
    });

    it('should return false if stake account not found', async () => {
      const { verifyStake } = await import('../staking.js');

      mockGetAccountInfo.mockResolvedValue(null);

      const result = await verifyStake('peer-notfound');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return false if account has no data', async () => {
      const { verifyStake } = await import('../staking.js');

      mockGetAccountInfo.mockResolvedValue({ data: null });

      const result = await verifyStake('peer-nodata');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return false on connection error', async () => {
      const { verifyStake } = await import('../staking.js');

      mockGetAccountInfo.mockRejectedValue(new Error('RPC timeout'));

      const result = await verifyStake('peer-error');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('RPC timeout');
    });

    it('should return error message for non-Error throws', async () => {
      const { verifyStake } = await import('../staking.js');

      mockGetAccountInfo.mockRejectedValue('string error');

      const result = await verifyStake('peer-non-error');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle stakeAccount when not array', async () => {
      const { verifyStake } = await import('../staking.js');

      const stakeData = Buffer.alloc(24);
      stakeData.writeBigUInt64LE(100n, 0);
      mockGetAccountInfo.mockResolvedValue({ data: stakeData });

      const result = await verifyStake('peer-array-test');

      expect(result.valid).toBe(true);
      expect(result.stakeInfo?.stakeAccount).toBeDefined();
    });
  });

  describe('getMinimumStake', () => {
    it('should return correct minimum for each tier', async () => {
      const { getMinimumStake } = await import('../staking.js');

      expect(getMinimumStake(0)).toBe(0);
      expect(getMinimumStake(1)).toBe(100);
      expect(getMinimumStake(2)).toBe(500);
      expect(getMinimumStake(3)).toBe(1000);
      expect(getMinimumStake(4)).toBe(5000);
      expect(getMinimumStake(5)).toBe(10000);
    });

    it('should return 0 for unknown tier', async () => {
      const { getMinimumStake } = await import('../staking.js');

      expect(getMinimumStake(999)).toBe(0);
    });
  });

  describe('computeTier', () => {
    it('should compute tier from stake amount', async () => {
      const { computeTier } = await import('../staking.js');

      expect(computeTier(0)).toBe(0);
      expect(computeTier(50)).toBe(0); // Below tier 1
      expect(computeTier(100)).toBe(1); // Exactly tier 1
      expect(computeTier(250)).toBe(1);
      expect(computeTier(500)).toBe(2); // Exactly tier 2
      expect(computeTier(750)).toBe(2);
      expect(computeTier(1000)).toBe(3); // Exactly tier 3
      expect(computeTier(2500)).toBe(3);
      expect(computeTier(5000)).toBe(4); // Exactly tier 4
      expect(computeTier(10000)).toBe(5); // Tier 5
    });

    it('should handle edge cases', async () => {
      const { computeTier } = await import('../staking.js');

      expect(computeTier(-1)).toBe(0); // Negative
      expect(computeTier(99.9)).toBe(0); // Non-integer below threshold
    });
  });

  describe('meetsMinimumStake', () => {
    it('should check if stake meets minimum for tier', async () => {
      const { meetsMinimumStake } = await import('../staking.js');

      expect(meetsMinimumStake(100, 1)).toBe(true);
      expect(meetsMinimumStake(99, 1)).toBe(false);
      expect(meetsMinimumStake(1000, 3)).toBe(true);
      expect(meetsMinimumStake(999, 3)).toBe(false);
    });
  });

  describe('getAllStakesForPeer', () => {
    it('should return stakes when valid', async () => {
      const { getAllStakesForPeer } = await import('../staking.js');

      const stakeData = Buffer.alloc(24);
      stakeData.writeBigUInt64LE(500n, 0);
      mockGetAccountInfo.mockResolvedValue({ data: stakeData });

      const stakes = await getAllStakesForPeer('peer-123');

      expect(stakes).toHaveLength(1);
      expect(stakes[0].stakedAmount).toBe(500);
    });

    it('should return empty array when invalid', async () => {
      const { getAllStakesForPeer } = await import('../staking.js');

      mockGetAccountInfo.mockResolvedValue(null);

      const stakes = await getAllStakesForPeer('peer-invalid');

      expect(stakes).toEqual([]);
    });
  });

  describe('getTotalNetworkStake', () => {
    it('should aggregate all stakes', async () => {
      const { getTotalNetworkStake } = await import('../staking.js');

      const account1Data = Buffer.alloc(24);
      account1Data.writeBigUInt64LE(100n, 0);

      const account2Data = Buffer.alloc(24);
      account2Data.writeBigUInt64LE(500n, 0);

      mockGetProgramAccounts.mockResolvedValue([
        { account: { data: account1Data } } as any,
        { account: { data: account2Data } } as any,
      ] as any);

      const total = await getTotalNetworkStake();

      expect(total).toBe(600);
    });

    it('should handle accounts with lockup data', async () => {
      const { getTotalNetworkStake } = await import('../staking.js');

      // Account with lockup timestamp (>16 bytes)
      const accountData = Buffer.alloc(24);
      accountData.writeBigUInt64LE(100n, 0);
      accountData.writeBigUInt64LE(1234567890n, 8); // lockupEnd

      mockGetProgramAccounts.mockResolvedValue([
        { account: { data: accountData } } as any,
      ] as any);

      const total = await getTotalNetworkStake();

      expect(total).toBe(100);
    });

    it('should handle accounts without lockup data', async () => {
      const { getTotalNetworkStake } = await import('../staking.js');

      // Account without lockup timestamp (<=16 bytes)
      const accountData = Buffer.alloc(16);
      accountData.writeBigUInt64LE(100n, 0);

      mockGetProgramAccounts.mockResolvedValue([
        { account: { data: accountData } } as any,
      ] as any);

      const total = await getTotalNetworkStake();

      expect(total).toBe(100);
    });

    it('should return 0 on error', async () => {
      const { getTotalNetworkStake } = await import('../staking.js');

      mockGetProgramAccounts.mockRejectedValue(new Error('RPC error') as any);

      const total = await getTotalNetworkStake();

      expect(total).toBe(0);
    });

    it('should return 0 if all accounts malformed', async () => {
      const { getTotalNetworkStake } = await import('../staking.js');

      mockGetProgramAccounts.mockResolvedValue([
        { account: { data: Buffer.from([1, 2, 3]) } as any }, // Too short
        { account: { data: Buffer.from([4, 5, 6]) } as any }, // Too short
      ] as any);

      const total = await getTotalNetworkStake();

      expect(total).toBe(0); // All malformed, return 0
    });
  });
});
