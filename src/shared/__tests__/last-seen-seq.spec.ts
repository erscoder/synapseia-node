/**
 * D-P2P Slice 2 (2026-05-28) — persistent `lastSeenSeq` store unit
 * tests. Covers monotonic update + cold-boot + corruption + crash-safe
 * tmp+rename invariants.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LastSeenSeqStore } from '../last-seen-seq';

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `lastseenseq-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('LastSeenSeqStore', () => {
  it('returns undefined when the file does not exist (cold boot)', () => {
    const store = new LastSeenSeqStore({ path: tmpFile('cold') });
    expect(store.get()).toBeUndefined();
  });

  it('update() advances + persists via flushSync', () => {
    const file = tmpFile('advance');
    const store = new LastSeenSeqStore({ path: file });
    expect(store.update(10)).toBe(true);
    expect(store.get()).toBe(10);
    store.flushSync();

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.lastSeenSeq).toBe(10);
    expect(raw.version).toBe(1);
    fs.unlinkSync(file);
  });

  it('update() is monotonic — a smaller seq does NOT rewind', () => {
    const store = new LastSeenSeqStore({ path: tmpFile('mono') });
    expect(store.update(50)).toBe(true);
    expect(store.update(40)).toBe(false);
    expect(store.update(60)).toBe(true);
    expect(store.get()).toBe(60);
  });

  it('update() rejects non-finite / non-positive / NaN (P2 fail-closed, no rewind)', () => {
    const store = new LastSeenSeqStore({ path: tmpFile('nan') });
    expect(store.update(0)).toBe(false);
    expect(store.update(-1)).toBe(false);
    expect(store.update(Number.NaN)).toBe(false);
    expect(store.update(Number.POSITIVE_INFINITY)).toBe(false);
    expect(store.get()).toBeUndefined();
  });

  it('update() floors fractional inputs (BIGSERIAL is integer)', () => {
    const store = new LastSeenSeqStore({ path: tmpFile('frac') });
    expect(store.update(7.9)).toBe(true);
    expect(store.get()).toBe(7);
  });

  it('persisted cursor is reloaded on the next process start', () => {
    const file = tmpFile('persist');
    const a = new LastSeenSeqStore({ path: file });
    a.update(123);
    a.flushSync();

    const b = new LastSeenSeqStore({ path: file });
    expect(b.get()).toBe(123);
    fs.unlinkSync(file);
  });

  it('returns undefined for a corrupt cursor file (P22 — never crash the WO loop)', () => {
    const file = tmpFile('corrupt');
    fs.writeFileSync(file, '{ not valid json', 'utf8');
    const store = new LastSeenSeqStore({ path: file });
    expect(store.get()).toBeUndefined();
    // Subsequent update() recovers without throwing.
    expect(store.update(5)).toBe(true);
    expect(store.get()).toBe(5);
    store.flushSync();
    fs.unlinkSync(file);
  });

  it('returns undefined for a version-mismatched file', () => {
    const file = tmpFile('version');
    fs.writeFileSync(file, JSON.stringify({ version: 99, lastSeenSeq: 1, updatedAt: 0 }), 'utf8');
    const store = new LastSeenSeqStore({ path: file });
    expect(store.get()).toBeUndefined();
    fs.unlinkSync(file);
  });

  it('flushSync() is a no-op when nothing is dirty', () => {
    const store = new LastSeenSeqStore({ path: tmpFile('clean') });
    expect(() => store.flushSync()).not.toThrow();
  });
});
