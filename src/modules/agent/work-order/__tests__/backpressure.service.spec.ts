import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { BackpressureService } from '../backpressure.service';

// Suppress logger output during tests
jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('BackpressureService', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MAX_CONCURRENT_WORK_ORDERS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MAX_CONCURRENT_WORK_ORDERS;
    } else {
      process.env.MAX_CONCURRENT_WORK_ORDERS = originalEnv;
    }
  });

  // ── Constructor ───────────────────────────────────────────────────────────

  it('defaults to max 2 concurrent work orders', () => {
    delete process.env.MAX_CONCURRENT_WORK_ORDERS;
    const svc = new BackpressureService();
    expect(svc.getMaxConcurrent()).toBe(2);
  });

  it('reads MAX_CONCURRENT_WORK_ORDERS from env', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '5';
    const svc = new BackpressureService();
    expect(svc.getMaxConcurrent()).toBe(5);
  });

  it('throws if MAX_CONCURRENT_WORK_ORDERS < 1', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '0';
    expect(() => new BackpressureService()).toThrow('must be >= 1');
  });

  // ── canAccept ─────────────────────────────────────────────────────────────

  it('canAccept returns true when under limit', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '2';
    const svc = new BackpressureService();
    expect(svc.canAccept()).toBe(true);
  });

  it('canAccept returns false when at limit', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '1';
    const svc = new BackpressureService();
    svc.acquire('wo-1');
    expect(svc.canAccept()).toBe(false);
  });

  // ── acquire ───────────────────────────────────────────────────────────────

  it('acquire returns true and tracks the work order', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '2';
    const svc = new BackpressureService();
    expect(svc.acquire('wo-1')).toBe(true);
    expect(svc.getInFlight()).toBe(1);
  });

  it('acquire returns false when at capacity', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '1';
    const svc = new BackpressureService();
    svc.acquire('wo-1');
    expect(svc.acquire('wo-2')).toBe(false);
    expect(svc.getInFlight()).toBe(1);
  });

  it('acquire is idempotent for the same work order ID', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '1';
    const svc = new BackpressureService();
    expect(svc.acquire('wo-1')).toBe(true);
    expect(svc.acquire('wo-1')).toBe(true);
    expect(svc.getInFlight()).toBe(1);
  });

  // ── release ───────────────────────────────────────────────────────────────

  it('release frees the slot', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '1';
    const svc = new BackpressureService();
    svc.acquire('wo-1');
    expect(svc.canAccept()).toBe(false);
    svc.release('wo-1');
    expect(svc.canAccept()).toBe(true);
    expect(svc.getInFlight()).toBe(0);
  });

  it('release is safe for unknown IDs', () => {
    const svc = new BackpressureService();
    expect(() => svc.release('nonexistent')).not.toThrow();
    expect(svc.getInFlight()).toBe(0);
  });

  // ── acquire/release cycle ─────────────────────────────────────────────────

  it('full acquire/release cycle allows re-use of slots', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '2';
    const svc = new BackpressureService();

    expect(svc.acquire('wo-1')).toBe(true);
    expect(svc.acquire('wo-2')).toBe(true);
    expect(svc.acquire('wo-3')).toBe(false); // at capacity

    svc.release('wo-1');
    expect(svc.getInFlight()).toBe(1);
    expect(svc.acquire('wo-3')).toBe(true); // slot freed
    expect(svc.getInFlight()).toBe(2);
  });

  // ── concurrent limit enforcement ──────────────────────────────────────────

  it('enforces limit across multiple sequential acquires', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '3';
    const svc = new BackpressureService();

    expect(svc.acquire('a')).toBe(true);
    expect(svc.acquire('b')).toBe(true);
    expect(svc.acquire('c')).toBe(true);
    expect(svc.acquire('d')).toBe(false);
    expect(svc.acquire('e')).toBe(false);
    expect(svc.getInFlight()).toBe(3);

    svc.release('b');
    expect(svc.acquire('d')).toBe(true);
    expect(svc.getInFlight()).toBe(3);
  });

  // ── getInFlightIds ────────────────────────────────────────────────────────

  it('getInFlightIds returns a snapshot of tracked IDs', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '3';
    const svc = new BackpressureService();
    svc.acquire('wo-x');
    svc.acquire('wo-y');
    const ids = svc.getInFlightIds();
    expect(ids.has('wo-x')).toBe(true);
    expect(ids.has('wo-y')).toBe(true);
    expect(ids.size).toBe(2);

    // Snapshot isolation: modifying original does not affect returned set
    svc.release('wo-x');
    expect(ids.has('wo-x')).toBe(true); // snapshot unchanged
    expect(svc.getInFlightIds().has('wo-x')).toBe(false); // new snapshot reflects release
  });
});
