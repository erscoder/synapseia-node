/**
 * Tests for the `console.warn` override that silences the
 * `bigint: Failed to load bindings, pure JS will be used` warning emitted
 * by `bigint-buffer` (transitive dep of @solana/web3.js) on machines
 * without a working native binding (typically Windows without a C++
 * toolchain). The pure-JS fallback is correct — the message is pure noise
 * and used to leak into the desktop SettingsPanel toast.
 *
 * The filter helpers live in their own module so they can be unit tested
 * without triggering the `import('./index.js')` side effect that
 * `bootstrap.ts` performs at load time.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  muteBigintBindingConsoleWarn,
  muteBigintBindingStderrWrite,
} from '../cli/bigint-warning-filter';

describe('muteBigintBindingConsoleWarn', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalWarn: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any[][];

  beforeEach(() => {
    originalWarn = console.warn;
    captured = [];
    // Install a base spy so we can detect which warnings actually pass
    // through. The override re-wraps THIS function.
    console.warn = jest.fn((...args: unknown[]) => {
      captured.push(args);
    }) as typeof console.warn;
    muteBigintBindingConsoleWarn();
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('silently drops the bigint-buffer "Failed to load bindings" warning', () => {
    console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)');
    expect(captured).toHaveLength(0);
  });

  it('forwards unrelated warnings untouched', () => {
    console.warn('some other warning');
    console.warn('Deprecation warning: foo');
    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual(['some other warning']);
    expect(captured[1]).toEqual(['Deprecation warning: foo']);
  });

  it('forwards warnings whose first arg is not a string', () => {
    const errObj = new Error('boom');
    console.warn(errObj, 'extra');
    expect(captured).toHaveLength(1);
    expect(captured[0][0]).toBe(errObj);
    expect(captured[0][1]).toBe('extra');
  });

  it('forwards a string that merely mentions bigint without the exact prefix', () => {
    // Defensive: the filter is prefix-anchored so unrelated bigint-related
    // diagnostics (e.g. from app code) still surface.
    console.warn('warning: bigint conversion underflowed');
    expect(captured).toHaveLength(1);
  });
});

describe('muteBigintBindingStderrWrite', () => {
  let originalWrite: typeof process.stderr.write;
  let captured: string[];

  beforeEach(() => {
    originalWrite = process.stderr.write;
    captured = [];
    // Install a base spy that the override will wrap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = function spy(chunk: any): boolean {
      const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
      captured.push(s);
      return true;
    } as typeof process.stderr.write;
    muteBigintBindingStderrWrite();
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it('silently drops the bigint-buffer warning line written to stderr', () => {
    process.stderr.write(
      'bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)\n',
    );
    expect(captured).toHaveLength(0);
  });

  it('forwards unrelated stderr writes untouched', () => {
    process.stderr.write('some other stderr line\n');
    expect(captured).toEqual(['some other stderr line\n']);
  });
});
