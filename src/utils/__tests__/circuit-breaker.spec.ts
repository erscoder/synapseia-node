import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker';

// Silence telemetry-tap'ed warn lines emitted by the breaker.
jest.mock('../logger', () => ({
  __esModule: true,
  default: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
}));

describe('CircuitBreaker', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  function makeBreaker() {
    return new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      windowMs: 1000,
      cooldownMs: 5000,
    });
  }

  it('passes successes through and stays closed', async () => {
    const cb = makeBreaker();
    await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
    expect(cb.getState()).toBe('closed');
  });

  it('opens after `failureThreshold` failures inside the window', async () => {
    const cb = makeBreaker();
    const fail = () => cb.exec(async () => { throw new Error('boom'); });

    await expect(fail()).rejects.toThrow('boom');
    await expect(fail()).rejects.toThrow('boom');
    await expect(fail()).rejects.toThrow('boom');

    expect(cb.getState()).toBe('open');
  });

  it('throws CircuitOpenError without invoking op while open', async () => {
    const cb = makeBreaker();
    const op = jest.fn(async () => { throw new Error('boom'); });
    for (let i = 0; i < 3; i++) {
      await expect(cb.exec(op as any)).rejects.toThrow('boom');
    }
    op.mockClear();

    await expect(cb.exec(op as any)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(op).not.toHaveBeenCalled();
  });

  it('expires old failures outside the window without tripping', async () => {
    const cb = makeBreaker();
    const fail = () => cb.exec(async () => { throw new Error('boom'); });

    await expect(fail()).rejects.toThrow('boom');
    await expect(fail()).rejects.toThrow('boom');

    // Advance past the failure window so the two failures age out.
    jest.setSystemTime(Date.now() + 2000);

    await expect(fail()).rejects.toThrow('boom');
    expect(cb.getState()).toBe('closed');
  });

  it('after cooldown enters half-open and closes on probe success', async () => {
    const cb = makeBreaker();
    const fail = () => cb.exec(async () => { throw new Error('boom'); });

    for (let i = 0; i < 3; i++) await expect(fail()).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    jest.setSystemTime(Date.now() + 5001);

    await expect(cb.exec(async () => 'recovered')).resolves.toBe('recovered');
    expect(cb.getState()).toBe('closed');
  });

  it('half-open probe failure re-opens the breaker', async () => {
    const cb = makeBreaker();
    const fail = () => cb.exec(async () => { throw new Error('boom'); });

    for (let i = 0; i < 3; i++) await expect(fail()).rejects.toThrow();
    jest.setSystemTime(Date.now() + 5001);

    // Probe fails → re-opened
    await expect(fail()).rejects.toThrow('boom');
    expect(cb.getState()).toBe('open');

    // Still open → next call throws CircuitOpenError without invoking op
    const op = jest.fn(async () => 'never called');
    await expect(cb.exec(op as any)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(op).not.toHaveBeenCalled();
  });
});
