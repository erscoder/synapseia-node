/**
 * Bug 20 v3 (2026-05-18) — per-WO consecutive-failure counter tests.
 *
 * Covers:
 *   - increment + persist + reload round-trip
 *   - shouldSkip behaviour at the cap boundary
 *   - TTL pruning of old entries (P30 reviewer-lesson — no permanent stranded state)
 *   - atomic write (tmp+rename) survives malformed file contents
 *   - clear() removes a single entry without affecting others
 *   - read-failure / corrupt-file degradation never crashes (P22)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WoFailureCountStore } from '../wo-failure-counts';

describe('WoFailureCountStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-failure-counts-test-'));
    filePath = path.join(tmpDir, 'counts.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 for unknown WO and does not skip', () => {
    const store = new WoFailureCountStore({ path: filePath, cap: 2 });
    expect(store.getCount('wo-x')).toBe(0);
    expect(store.shouldSkip('wo-x')).toBe(false);
  });

  it('increments and persists across instances', () => {
    const s1 = new WoFailureCountStore({ path: filePath, cap: 2 });
    const r1 = s1.markFailedTimeout('wo-a', 'obabel-gen3d-timeout');
    expect(r1).toEqual({ count: 1, cappedNow: false });
    const s2 = new WoFailureCountStore({ path: filePath, cap: 2 });
    expect(s2.getCount('wo-a')).toBe(1);
    expect(s2.shouldSkip('wo-a')).toBe(false);
  });

  it('shouldSkip flips to true when count >= cap', () => {
    const store = new WoFailureCountStore({ path: filePath, cap: 2 });
    expect(store.markFailedTimeout('wo-b', 'r').count).toBe(1);
    expect(store.shouldSkip('wo-b')).toBe(false);
    const r2 = store.markFailedTimeout('wo-b', 'r');
    expect(r2).toEqual({ count: 2, cappedNow: true });
    expect(store.shouldSkip('wo-b')).toBe(true);
  });

  it('clear() removes the entry and resets shouldSkip', () => {
    const store = new WoFailureCountStore({ path: filePath, cap: 2 });
    store.markFailedTimeout('wo-c', 'r');
    store.markFailedTimeout('wo-c', 'r');
    expect(store.shouldSkip('wo-c')).toBe(true);
    store.clear('wo-c');
    expect(store.getCount('wo-c')).toBe(0);
    expect(store.shouldSkip('wo-c')).toBe(false);
    // Verify persistence — a new instance also sees the cleared state.
    const s2 = new WoFailureCountStore({ path: filePath, cap: 2 });
    expect(s2.getCount('wo-c')).toBe(0);
  });

  it('prunes entries older than ttlMs on load (P30)', () => {
    let clock = 1_000_000_000_000;
    const ttlMs = 60_000;
    const s1 = new WoFailureCountStore({ path: filePath, cap: 2, ttlMs, now: () => clock });
    s1.markFailedTimeout('wo-old', 'r');
    expect(s1.getCount('wo-old')).toBe(1);

    // Advance clock past TTL.
    clock += ttlMs + 1;
    const s2 = new WoFailureCountStore({ path: filePath, cap: 2, ttlMs, now: () => clock });
    expect(s2.getCount('wo-old')).toBe(0);
    expect(s2.shouldSkip('wo-old')).toBe(false);
  });

  it('keeps unrelated entries when clear() drops one', () => {
    const store = new WoFailureCountStore({ path: filePath, cap: 2 });
    store.markFailedTimeout('wo-keep-1', 'r');
    store.markFailedTimeout('wo-drop', 'r');
    store.markFailedTimeout('wo-keep-2', 'r');
    store.clear('wo-drop');
    expect(store.getCount('wo-keep-1')).toBe(1);
    expect(store.getCount('wo-keep-2')).toBe(1);
    expect(store.getCount('wo-drop')).toBe(0);
  });

  it('degrades gracefully on corrupt file (P22 — never crash WO loop)', () => {
    fs.writeFileSync(filePath, 'this is not json{{{');
    const store = new WoFailureCountStore({ path: filePath, cap: 2 });
    // Reading any WO should not throw; counts start at 0.
    expect(() => store.getCount('wo-anything')).not.toThrow();
    expect(store.getCount('wo-anything')).toBe(0);
    expect(() => store.markFailedTimeout('wo-anything', 'r')).not.toThrow();
  });

  it('degrades gracefully on missing parent dir', () => {
    const nestedPath = path.join(tmpDir, 'deep', 'nested', 'counts.json');
    const store = new WoFailureCountStore({ path: nestedPath, cap: 2 });
    const r = store.markFailedTimeout('wo-d', 'r');
    expect(r.count).toBe(1);
    // Subsequent instance reads the freshly-created file.
    const s2 = new WoFailureCountStore({ path: nestedPath, cap: 2 });
    expect(s2.getCount('wo-d')).toBe(1);
  });

  it('atomic-write: no tmp file lingers after a successful mark', () => {
    const store = new WoFailureCountStore({ path: filePath, cap: 2 });
    store.markFailedTimeout('wo-e', 'r');
    const entries = fs.readdirSync(tmpDir);
    const tmpFiles = entries.filter(f => f.startsWith('counts.json.tmp'));
    expect(tmpFiles).toEqual([]);
    expect(entries).toContain('counts.json');
  });

  it('honours WO_TIMEOUT_FAILURE_CAP env override via explicit cap', () => {
    // env-var path is exercised by parseTimeoutCapEnv; we pass cap=5 explicitly here.
    const store = new WoFailureCountStore({ path: filePath, cap: 5 });
    for (let i = 0; i < 4; i++) store.markFailedTimeout('wo-f', 'r');
    expect(store.shouldSkip('wo-f')).toBe(false);
    store.markFailedTimeout('wo-f', 'r');
    expect(store.shouldSkip('wo-f')).toBe(true);
  });
});
