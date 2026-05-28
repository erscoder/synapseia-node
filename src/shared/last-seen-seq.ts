/**
 * D-P2P Slice 2 (2026-05-28) — persistent `lastSeenSeq` store for WO
 * reconciliation.
 *
 * The node tracks the highest `seq` value observed on either the
 * gossipsub WO_AVAILABLE topic OR the `/work-orders/available` HTTP
 * fallback. On every HTTP fallback poll it passes that value back as
 * `?since=<seq>` so the coord ships ONLY WOs published after the last
 * one this node saw — closing the offline-window without re-sending the
 * full assignable queue every poll.
 *
 * Persistence: survives daemon restarts (`~/.synapseia/last-seen-seq.json`,
 * mirrors `wo-failure-counts.json` pattern, atomic tmp+rename write to
 * tolerate crash-mid-write). Stale value after a long offline is fine —
 * the coord still ships the strict delta `wo.seq > since`. A cold boot
 * with no file falls back to `undefined` → coord returns the full pool
 * (legacy behaviour) so first-boot UX is preserved.
 *
 * Concurrency: in-memory cache + throttled disk flush. `update()` is
 * monotonic (never decreases) — a late-arriving gossipsub envelope with
 * a smaller seq cannot rewind the cursor.
 *
 * P22: every public method MUST degrade gracefully on persistence
 * error — the WO loop's discovery path must never crash on a corrupted
 * cursor file. Mirrors the `WoFailureCountStore` contract.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../utils/logger';

const DEFAULT_PATH = path.join(os.homedir(), '.synapseia', 'last-seen-seq.json');
/**
 * Throttle for disk flushes. A stream of envelopes only schedules one
 * write per FLUSH_INTERVAL_MS; the last write before process exit is
 * also forced via `flushSync()` so a graceful shutdown never strands
 * the cursor in memory.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

interface SeqFile {
  version: 1;
  /** Highest seq value observed, monotonically non-decreasing. */
  lastSeenSeq: number;
  /** Wall-clock of last update for operator diagnostics. */
  updatedAt: number;
}

export interface LastSeenSeqStoreOptions {
  /** Override the persistence path (test injection point). */
  path?: string;
  /** Override the flush throttle (test injection point). */
  flushIntervalMs?: number;
  /** Override the clock source (test injection point). */
  now?: () => number;
}

export class LastSeenSeqStore {
  private readonly filePath: string;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;
  private cache: SeqFile | null = null;
  private pendingFlush: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(opts: LastSeenSeqStoreOptions = {}) {
    this.filePath = opts.path ?? DEFAULT_PATH;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Returns the current cursor value, or `undefined` if never set.
   * Lazy-loaded from disk on first access. Failures return `undefined`
   * (cold-boot semantics — coord ships full pool).
   */
  get(): number | undefined {
    const file = this.load();
    return file?.lastSeenSeq;
  }

  /**
   * Update the cursor IFF `seq > current`. Returns true when the cursor
   * advanced (caller can log / increment a counter). Schedules a
   * throttled disk flush; an immediate flush is NOT needed because the
   * coord-side reconciliation tolerates a stale cursor (the WHERE is
   * `seq > since` — over-shipping is always safe).
   *
   * P2 fail-closed: a non-finite / non-positive `seq` is silently
   * ignored (no rewind, no NaN write, no log spam). Operators see
   * monotone advance only.
   */
  update(seq: number): boolean {
    if (!Number.isFinite(seq) || seq < 1) return false;
    const intSeq = Math.floor(seq);
    const file = this.load() ?? { version: 1, lastSeenSeq: 0, updatedAt: 0 };
    if (intSeq <= file.lastSeenSeq) return false;
    file.lastSeenSeq = intSeq;
    file.updatedAt = this.now();
    this.cache = file;
    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  /**
   * Force-flush the cursor to disk and clear any pending timer. Called
   * from the node's graceful-shutdown handler so the last update is
   * never stranded in memory.
   */
  flushSync(): void {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (this.dirty) this.save();
  }

  private scheduleFlush(): void {
    if (this.pendingFlush) return;
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      if (this.dirty) this.save();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive for the flush timer (P22 — must
    // not prevent graceful shutdown). The cursor is also flushed
    // synchronously from the shutdown hook.
    if (typeof this.pendingFlush.unref === 'function') this.pendingFlush.unref();
  }

  private load(): SeqFile | null {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      this.cache = null;
      return null;
    }
    let parsed: SeqFile;
    try {
      parsed = JSON.parse(raw) as SeqFile;
    } catch (err) {
      logger.warn(`[LastSeenSeq] failed to parse ${this.filePath}: ${(err as Error).message} — resetting`);
      this.cache = null;
      return null;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== 1 ||
      !Number.isFinite(parsed.lastSeenSeq) ||
      parsed.lastSeenSeq < 0
    ) {
      this.cache = null;
      return null;
    }
    this.cache = parsed;
    return this.cache;
  }

  private save(): void {
    if (!this.cache) return;
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* writeFile below will surface real errors */
    }
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${this.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.cache), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
      this.dirty = false;
    } catch (err) {
      logger.warn(`[LastSeenSeq] failed to persist ${this.filePath}: ${(err as Error).message}`);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /** Test-only: reset the in-memory cache so a freshly-written file is re-read. */
  __resetCacheForTests(): void {
    this.cache = null;
    this.dirty = false;
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
  }
}

let singleton: LastSeenSeqStore | null = null;

export function getLastSeenSeqStore(): LastSeenSeqStore {
  if (!singleton) singleton = new LastSeenSeqStore();
  return singleton;
}

export function __resetLastSeenSeqSingletonForTests(): void {
  if (singleton) singleton.__resetCacheForTests();
  singleton = null;
}
