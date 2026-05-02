/**
 * Tests for `KgShardOwnershipStore`.
 *
 * Plan D.4.
 */
import { KgShardOwnershipStore } from '../KgShardOwnershipStore';

describe('KgShardOwnershipStore', () => {
  it('set + has + delete are idempotent', () => {
    let now = 1_000;
    const store = new KgShardOwnershipStore(() => now);

    store.set(7, now + 60_000);
    expect(store.has(7)).toBe(true);
    store.set(7, now + 60_000); // idempotent upsert
    expect(store.has(7)).toBe(true);

    store.delete(7);
    expect(store.has(7)).toBe(false);
    store.delete(7); // double-delete safe
    expect(store.has(7)).toBe(false);
  });

  it('treats expired grants as absent and prunes them on has()', () => {
    let now = 1_000;
    const store = new KgShardOwnershipStore(() => now);

    store.set(2, now + 5_000);
    expect(store.has(2)).toBe(true);

    now += 6_000;
    expect(store.has(2)).toBe(false);
    // After a `has()` returns false on an expired grant the entry must be
    // gone so a subsequent `expiresAt` doesn't surface stale data.
    expect(store.expiresAt(2)).toBeUndefined();
  });

  it('refuses to store grants that are already expired', () => {
    let now = 1_000;
    const store = new KgShardOwnershipStore(() => now);

    store.set(0, now - 1);
    expect(store.has(0)).toBe(false);
    store.set(0, now);
    expect(store.has(0)).toBe(false);
  });

  it('rejects negative shard ids and non-finite expiries', () => {
    const store = new KgShardOwnershipStore(() => 1_000);
    store.set(-1, 9_999);
    store.set(Number.NaN, 9_999);
    store.set(0, Number.NaN);
    expect(store.list()).toEqual([]);
  });

  it('list() returns active shards sorted and prunes expired ones', () => {
    let now = 1_000;
    const store = new KgShardOwnershipStore(() => now);
    store.set(3, now + 10_000);
    store.set(1, now + 10_000);
    store.set(2, now + 5_000);
    expect(store.list()).toEqual([1, 2, 3]);

    now += 6_000;
    expect(store.list()).toEqual([1, 3]);
  });

  it('expiresAt returns the stored ms value', () => {
    const store = new KgShardOwnershipStore(() => 1_000);
    store.set(5, 5_000);
    expect(store.expiresAt(5)).toBe(5_000);
  });
});
