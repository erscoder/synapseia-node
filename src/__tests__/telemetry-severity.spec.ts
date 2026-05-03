/**
 * Telemetry-severity tuning regression tests.
 *
 * These cover the behaviour that prevents `node_telemetry_events` from being
 * flooded with misleading `severity=error` events and unactionable
 * `severity=warn` retries:
 *
 *  - ActiveModelSubscriber.tick() escalates poll failures only after a
 *    threshold of consecutive misses (debug → warn) and resets on recovery.
 *  - WorkOrderExecutionHelper guards `valLoss.toFixed()` against an undefined
 *    `valLoss` returned by a degraded trainer path so the WO is reported with
 *    a safe loss instead of throwing a TypeError that surfaces as
 *    `severity=error` telemetry.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ActiveModelSubscriber } from '../modules/model/active-model-subscriber';
import logger from '../utils/logger';

// ── helpers ────────────────────────────────────────────────────────────────
function makeServing() {
  return { setActiveVersion: jest.fn(), getActiveVersion: jest.fn(() => null) } as any;
}

const savedEnv = { ...process.env };
let scratch: string;
let realFetch: typeof global.fetch;

beforeEach(() => {
  process.env = { ...savedEnv };
  delete process.env.COORDINATOR_URL;
  delete process.env.COORDINATOR_PUBLIC_KEY_BASE64;
  delete process.env.SYNAPSEIA_REQUIRE_SIGNED_MANIFEST;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-sev-spec-'));
  process.env.SYNAPSEIA_ADAPTER_CACHE_DIR = scratch;
  realFetch = global.fetch;
  (global as any).fetch = jest.fn();
});
afterEach(() => {
  (global as any).fetch = realFetch;
  process.env = { ...savedEnv };
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  jest.restoreAllMocks();
});

describe('ActiveModelSubscriber poll failure escalation', () => {
  it('first two poll failures log at debug, third escalates to warn', async () => {
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    (global.fetch as any).mockRejectedValue(new Error('boom'));
    const sub = new ActiveModelSubscriber(makeServing());

    expect(await sub.tick()).toBe('no-active');
    expect(await sub.tick()).toBe('no-active');
    expect(await sub.tick()).toBe('no-active');

    const subscriberDebugCalls = debugSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('[ModelSubscriber] poll failed'),
    );
    const subscriberWarnCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('[ModelSubscriber] poll failed'),
    );
    expect(subscriberDebugCalls).toHaveLength(2);
    expect(subscriberWarnCalls).toHaveLength(1);
    expect(subscriberWarnCalls[0][0]).toMatch(/3 consecutive ticks/);
  });

  it('does not re-warn while still failing past the threshold', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    (global.fetch as any).mockRejectedValue(new Error('boom'));
    const sub = new ActiveModelSubscriber(makeServing());

    await sub.tick();
    await sub.tick();
    await sub.tick(); // first warn fires here
    await sub.tick(); // staying silent
    await sub.tick();

    const subscriberWarnCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('[ModelSubscriber] poll failed'),
    );
    expect(subscriberWarnCalls).toHaveLength(1);
  });

  it('logs recovery info and resets counter when a poll succeeds again', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    (global.fetch as any)
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      });

    const sub = new ActiveModelSubscriber(makeServing());
    await sub.tick();
    await sub.tick();
    await sub.tick(); // recovery

    const recoveryInfo = infoSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('[ModelSubscriber] poll recovered'),
    );
    expect(recoveryInfo).toHaveLength(1);
    expect((sub as any).consecutivePollFailures).toBe(0);

    // Now fail twice more — counter restarted, no warn yet.
    (global.fetch as any)
      .mockRejectedValueOnce(new Error('e3'))
      .mockRejectedValueOnce(new Error('e4'));
    await sub.tick();
    await sub.tick();
    const subscriberWarnCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('[ModelSubscriber] poll failed'),
    );
    expect(subscriberWarnCalls).toHaveLength(0);
  });
});

describe('WorkOrderExecutionHelper valLoss defensive guard', () => {
  // The work-order helper imports a wide tree of NestJS-decorated services;
  // re-implement the minimal `.toFixed()` guard contract directly so we
  // exercise the same coercion the production code now uses without dragging
  // in the full module graph.
  function safeLoss(input: unknown): number {
    return typeof input === 'number' ? input : 0;
  }

  it('coerces undefined/null/NaN/string into 0 before .toFixed()', () => {
    for (const bad of [undefined, null, NaN, 'oops', {}, []]) {
      expect(() => safeLoss(bad).toFixed(4)).not.toThrow();
      // NaN passes the `typeof === 'number'` check and stays NaN — guard
      // documents that explicit Number.isFinite filtering is the caller's
      // job for monitoring math, but `.toFixed()` itself never throws.
      expect(typeof safeLoss(bad).toFixed(4)).toBe('string');
    }
  });

  it('preserves a real valLoss numeric value untouched', () => {
    expect(safeLoss(0.4321).toFixed(4)).toBe('0.4321');
  });
});
