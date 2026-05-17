import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  BackpressureService,
  classifyWorkOrderSlot,
} from '../backpressure.service';

// Suppress logger output during tests
jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('BackpressureService', () => {
  // Capture and restore all 3 env keys so tests are fully isolated regardless
  // of which env knob each test exercises.
  let originalLegacy: string | undefined;
  let originalHeavy: string | undefined;
  let originalLight: string | undefined;

  beforeEach(() => {
    originalLegacy = process.env.MAX_CONCURRENT_WORK_ORDERS;
    originalHeavy = process.env.MAX_HEAVY_WORK_ORDERS;
    originalLight = process.env.MAX_LIGHT_WORK_ORDERS;
    delete process.env.MAX_CONCURRENT_WORK_ORDERS;
    delete process.env.MAX_HEAVY_WORK_ORDERS;
    delete process.env.MAX_LIGHT_WORK_ORDERS;
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('MAX_CONCURRENT_WORK_ORDERS', originalLegacy);
    restore('MAX_HEAVY_WORK_ORDERS', originalHeavy);
    restore('MAX_LIGHT_WORK_ORDERS', originalLight);
  });

  // ── classifyWorkOrderSlot ────────────────────────────────────────────────

  describe('classifyWorkOrderSlot', () => {
    it('classifies TRAINING family as HEAVY', () => {
      expect(classifyWorkOrderSlot('TRAINING')).toBe('HEAVY');
      expect(classifyWorkOrderSlot('DILOCO_TRAINING')).toBe('HEAVY');
      expect(classifyWorkOrderSlot('LORA_TRAINING')).toBe('HEAVY');
    });

    it('classifies inference / research / docking / lora-validation as LIGHT', () => {
      expect(classifyWorkOrderSlot('CPU_INFERENCE')).toBe('LIGHT');
      expect(classifyWorkOrderSlot('GPU_INFERENCE')).toBe('LIGHT');
      expect(classifyWorkOrderSlot('MOLECULAR_DOCKING')).toBe('LIGHT');
      expect(classifyWorkOrderSlot('RESEARCH')).toBe('LIGHT');
      expect(classifyWorkOrderSlot('LORA_VALIDATION')).toBe('LIGHT');
    });

    it('falls back to LIGHT for unknown / missing type (P2 fail-safe)', () => {
      expect(classifyWorkOrderSlot(undefined)).toBe('LIGHT');
      expect(classifyWorkOrderSlot(null)).toBe('LIGHT');
      expect(classifyWorkOrderSlot('')).toBe('LIGHT');
      expect(classifyWorkOrderSlot('UNKNOWN_NEW_TYPE')).toBe('LIGHT');
    });

    it('is case-insensitive', () => {
      expect(classifyWorkOrderSlot('training')).toBe('HEAVY');
      expect(classifyWorkOrderSlot('Diloco_Training')).toBe('HEAVY');
    });
  });

  // ── Constructor — per-class env ──────────────────────────────────────────

  it('defaults to HEAVY=1, LIGHT=2 when no env set', () => {
    const svc = new BackpressureService();
    expect(svc.getMaxByClass('HEAVY')).toBe(1);
    expect(svc.getMaxByClass('LIGHT')).toBe(2);
    expect(svc.getMaxConcurrent()).toBe(3); // sum
  });

  it('reads MAX_HEAVY_WORK_ORDERS and MAX_LIGHT_WORK_ORDERS from env', () => {
    process.env.MAX_HEAVY_WORK_ORDERS = '2';
    process.env.MAX_LIGHT_WORK_ORDERS = '4';
    const svc = new BackpressureService();
    expect(svc.getMaxByClass('HEAVY')).toBe(2);
    expect(svc.getMaxByClass('LIGHT')).toBe(4);
  });

  it('throws if MAX_HEAVY_WORK_ORDERS < 1', () => {
    process.env.MAX_HEAVY_WORK_ORDERS = '0';
    expect(() => new BackpressureService()).toThrow(/MAX_HEAVY_WORK_ORDERS must be >= 1/);
  });

  it('throws if MAX_LIGHT_WORK_ORDERS < 1', () => {
    process.env.MAX_LIGHT_WORK_ORDERS = '0';
    expect(() => new BackpressureService()).toThrow(/MAX_LIGHT_WORK_ORDERS must be >= 1/);
  });

  // ── Legacy MAX_CONCURRENT_WORK_ORDERS back-compat ────────────────────────

  it('legacy MAX_CONCURRENT_WORK_ORDERS interpreted as LIGHT only (HEAVY pinned to 1)', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '5';
    const svc = new BackpressureService();
    expect(svc.getMaxByClass('LIGHT')).toBe(5);
    expect(svc.getMaxByClass('HEAVY')).toBe(1);
  });

  it('legacy env ignored when MAX_HEAVY_WORK_ORDERS is set', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '5';
    process.env.MAX_HEAVY_WORK_ORDERS = '3';
    const svc = new BackpressureService();
    // legacy ignored; heavy from env; light back to default (2)
    expect(svc.getMaxByClass('HEAVY')).toBe(3);
    expect(svc.getMaxByClass('LIGHT')).toBe(2);
  });

  it('legacy env ignored when MAX_LIGHT_WORK_ORDERS is set', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '5';
    process.env.MAX_LIGHT_WORK_ORDERS = '7';
    const svc = new BackpressureService();
    expect(svc.getMaxByClass('LIGHT')).toBe(7);
    expect(svc.getMaxByClass('HEAVY')).toBe(1);
  });

  it('throws if legacy MAX_CONCURRENT_WORK_ORDERS is invalid', () => {
    process.env.MAX_CONCURRENT_WORK_ORDERS = '0';
    expect(() => new BackpressureService()).toThrow(/MAX_CONCURRENT_WORK_ORDERS must be >= 1/);
  });

  // ── canAccept per-class ──────────────────────────────────────────────────

  it('canAccept(LIGHT-type) returns true when light bucket has room', () => {
    const svc = new BackpressureService(); // H=1, L=2
    expect(svc.canAccept('CPU_INFERENCE')).toBe(true);
  });

  it('canAccept(HEAVY-type) returns false when heavy bucket is full', () => {
    const svc = new BackpressureService();
    svc.acquire('wo-h', 'TRAINING');
    expect(svc.canAccept('TRAINING')).toBe(false);
  });

  it('HEAVY full does not block LIGHT acceptance', () => {
    const svc = new BackpressureService();
    svc.acquire('wo-h', 'TRAINING');
    expect(svc.canAccept('CPU_INFERENCE')).toBe(true);
  });

  it('LIGHT full does not block HEAVY acceptance', () => {
    process.env.MAX_LIGHT_WORK_ORDERS = '1';
    const svc = new BackpressureService();
    svc.acquire('wo-l', 'CPU_INFERENCE');
    expect(svc.canAccept('CPU_INFERENCE')).toBe(false);
    expect(svc.canAccept('DILOCO_TRAINING')).toBe(true);
  });

  it('canAccept() with no arg defaults to LIGHT bucket', () => {
    process.env.MAX_LIGHT_WORK_ORDERS = '1';
    const svc = new BackpressureService();
    expect(svc.canAccept()).toBe(true);
    svc.acquire('wo-l', 'CPU_INFERENCE');
    expect(svc.canAccept()).toBe(false); // light full
  });

  // ── acquire per-class ────────────────────────────────────────────────────

  it('acquire LIGHT type fills LIGHT bucket', () => {
    const svc = new BackpressureService(); // H=1, L=2
    expect(svc.acquire('wo-1', 'CPU_INFERENCE')).toBe(true);
    expect(svc.acquire('wo-2', 'RESEARCH')).toBe(true);
    expect(svc.acquire('wo-3', 'GPU_INFERENCE')).toBe(false); // light full
    expect(svc.getInFlightByClass('LIGHT')).toBe(2);
    expect(svc.getInFlightByClass('HEAVY')).toBe(0);
  });

  it('acquire HEAVY type fills HEAVY bucket independently', () => {
    const svc = new BackpressureService(); // H=1, L=2
    expect(svc.acquire('wo-h1', 'TRAINING')).toBe(true);
    expect(svc.acquire('wo-h2', 'DILOCO_TRAINING')).toBe(false); // heavy full
    expect(svc.getInFlightByClass('HEAVY')).toBe(1);
  });

  it('1 HEAVY + 2 LIGHT can run concurrently (full capacity default)', () => {
    const svc = new BackpressureService(); // H=1, L=2
    expect(svc.acquire('train', 'DILOCO_TRAINING')).toBe(true);
    expect(svc.acquire('inf1', 'CPU_INFERENCE')).toBe(true);
    expect(svc.acquire('inf2', 'RESEARCH')).toBe(true);
    expect(svc.getInFlight()).toBe(3);
    // Any more — heavy OR light — is rejected
    expect(svc.acquire('train2', 'LORA_TRAINING')).toBe(false);
    expect(svc.acquire('inf3', 'GPU_INFERENCE')).toBe(false);
  });

  it('acquire with no type defaults to LIGHT bucket (P2 fail-safe)', () => {
    const svc = new BackpressureService();
    expect(svc.acquire('wo-untyped')).toBe(true);
    expect(svc.getInFlightByClass('LIGHT')).toBe(1);
    expect(svc.getInFlightByClass('HEAVY')).toBe(0);
  });

  it('acquire is idempotent for the same WO id; original class wins', () => {
    const svc = new BackpressureService();
    expect(svc.acquire('wo-x', 'CPU_INFERENCE')).toBe(true);
    expect(svc.acquire('wo-x', 'TRAINING')).toBe(true); // idempotent, type ignored
    expect(svc.getInFlightByClass('LIGHT')).toBe(1);
    expect(svc.getInFlightByClass('HEAVY')).toBe(0);
  });

  // ── release per-class ────────────────────────────────────────────────────

  it('release returns slot to the original bucket', () => {
    const svc = new BackpressureService();
    svc.acquire('wo-h', 'TRAINING');
    expect(svc.getInFlightByClass('HEAVY')).toBe(1);
    svc.release('wo-h'); // caller does not pass type
    expect(svc.getInFlightByClass('HEAVY')).toBe(0);
    // Heavy bucket freed; can acquire another heavy
    expect(svc.acquire('wo-h2', 'DILOCO_TRAINING')).toBe(true);
  });

  it('release frees the right bucket when mixed inflight', () => {
    const svc = new BackpressureService(); // H=1, L=2
    svc.acquire('h', 'TRAINING');
    svc.acquire('l1', 'CPU_INFERENCE');
    svc.acquire('l2', 'RESEARCH');
    svc.release('l1');
    expect(svc.getInFlightByClass('HEAVY')).toBe(1);
    expect(svc.getInFlightByClass('LIGHT')).toBe(1);
    // Re-acquire a light slot now possible
    expect(svc.acquire('l3', 'GPU_INFERENCE')).toBe(true);
  });

  it('release is safe for unknown IDs', () => {
    const svc = new BackpressureService();
    expect(() => svc.release('nonexistent')).not.toThrow();
    expect(svc.getInFlight()).toBe(0);
  });

  // ── getInFlightIds ────────────────────────────────────────────────────────

  it('getInFlightIds returns a snapshot of all tracked IDs across classes', () => {
    process.env.MAX_HEAVY_WORK_ORDERS = '2';
    process.env.MAX_LIGHT_WORK_ORDERS = '2';
    const svc = new BackpressureService();
    svc.acquire('h-a', 'TRAINING');
    svc.acquire('l-x', 'CPU_INFERENCE');
    svc.acquire('l-y', 'RESEARCH');
    const ids = svc.getInFlightIds();
    expect(ids.has('h-a')).toBe(true);
    expect(ids.has('l-x')).toBe(true);
    expect(ids.has('l-y')).toBe(true);
    expect(ids.size).toBe(3);

    // Snapshot isolation
    svc.release('l-x');
    expect(ids.has('l-x')).toBe(true); // snapshot unchanged
    expect(svc.getInFlightIds().has('l-x')).toBe(false);
  });
});
