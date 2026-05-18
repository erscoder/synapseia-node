/**
 * Per-WO failure counter with atomic-write persistence (Bug 20 v3,
 * 2026-05-18).
 *
 * Observed live: `wo_docking_dp_5542e258-9c6_a_1779120600222_dbf771` timed
 * out FOUR consecutive times (16:25, 17:00, 17:32, 17:58, 18:48 UTC) on a
 * single pod. Coord kept redispatching, pod kept failing the same WO,
 * wasting CPU + slot capacity. Both `--gen3d med` and `--gen3d fast` tiers
 * (Slice 5 / Bug 20 v2) hit their 300s caps for this ligand intrinsically.
 *
 * Strategy: persistent per-WO counter incremented on every timeout. After
 * `MAX_TIMEOUT_FAILURES` (default 2), the WO is locally skipped — the
 * pre-fetch filter in FetchWorkOrdersNode reads this counter and rejects
 * the WO at the poll stage. Coord-side redispatch is unaffected; the WO
 * gets picked up by a different pod (with different obabel/RDKit
 * availability), and this pod stops burning slots on it.
 *
 * Persistence: counter survives daemon restarts so a flapping WO that
 * fails once on each of two consecutive boots still hits the cap. Atomic
 * write (tmp + rename) so a crash mid-write cannot corrupt the file (P3
 * reviewer-lesson — race fixes must consider crash semantics too).
 *
 * TTL: entries older than `ENTRY_TTL_MS` (24h default) are pruned on
 * load. Without TTL the file grows unbounded and a WO whose underlying
 * cause is fixed (operator installs RDKit, upgrades obabel, etc.) stays
 * permanently blocked (P30 reviewer-lesson — orphan transient state
 * needs a resume-reset path). Operators can also wipe
 * `~/.synapseia/wo-failure-counts.json` directly to reset all counters.
 *
 * P22 reviewer-lesson — the pre-fetch filter that consumes this counter
 * MUST NOT crash the WO loop on read failure. All public methods catch
 * and degrade gracefully (return 0 / treat as "not skipped").
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../utils/logger';

const DEFAULT_PATH = path.join(os.homedir(), '.synapseia', 'wo-failure-counts.json');

/**
 * After this many consecutive timeouts for the SAME WO id, the WO is
 * locally skipped. Coord may keep dispatching; the pod's pre-fetch
 * filter blocks accept. Operator override via WO_TIMEOUT_FAILURE_CAP.
 *
 * Env semantics (Bug 0.8.90 M1, P31 reviewer-lesson — env clamp):
 *   - unset / empty / whitespace        → default (2)
 *   - "0"                                → DISABLED (`shouldSkip` always
 *                                          returns false; counter still
 *                                          increments for diagnostics)
 *   - negative / non-numeric / NaN       → default (2)
 *   - valid positive integer             → that value
 *
 * The 0.8.89 implementation coerced `0` to the default, which made the
 * feature impossible to disable from the environment without a code
 * change. 0.8.90 honours `0` as the explicit kill-switch.
 */
function parseTimeoutCapEnv(): number {
  const raw = process.env.WO_TIMEOUT_FAILURE_CAP;
  if (!raw || raw.trim() === '') return 2;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 2;
  if (parsed < 0) return 2;
  // parsed === 0 → disabled. parsed > 0 → use the override.
  return parsed;
}

/**
 * Entries older than this are pruned on next load. 24h matches the
 * typical operator-intervention window — if a node-side fix lands
 * (RDKit install, obabel upgrade), counters reset within a day.
 * Override via WO_FAILURE_TTL_MS.
 *
 * Env semantics (Bug 0.8.90 M1, P31 reviewer-lesson — env clamp):
 *   - unset / empty / whitespace        → default (24h)
 *   - "0"                                → DISABLED (entries NEVER prune;
 *                                          equivalent to TTL=Infinity).
 *                                          Pairs with `cap=0` for "no
 *                                          local skipping" semantics.
 *   - negative / non-numeric / NaN       → default (24h)
 *   - valid positive integer             → that many ms
 */
function parseEntryTtlEnv(): number {
  const raw = process.env.WO_FAILURE_TTL_MS;
  if (!raw || raw.trim() === '') return 24 * 60 * 60 * 1000;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 24 * 60 * 60 * 1000;
  if (parsed < 0) return 24 * 60 * 60 * 1000;
  // parsed === 0 → disabled (no pruning). parsed > 0 → use the override.
  return parsed;
}

interface FailureEntry {
  /** Number of consecutive timeouts for this WO. */
  count: number;
  /** Last-update unix ms. Used for TTL pruning. */
  updatedAt: number;
  /** Most recent timeout reason, for operator diagnostics. */
  reason: string;
}

interface FailureFile {
  version: 1;
  entries: Record<string, FailureEntry>;
}

export interface WoFailureCountStoreOptions {
  /** Override the persistence path (test injection point). */
  path?: string;
  /** Override the timeout cap (default: env WO_TIMEOUT_FAILURE_CAP or 2). */
  cap?: number;
  /** Override the TTL (default: env WO_FAILURE_TTL_MS or 24h). */
  ttlMs?: number;
  /** Override the clock source (test injection point). */
  now?: () => number;
}

export class WoFailureCountStore {
  private readonly filePath: string;
  private readonly cap: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: FailureFile | null = null;

  constructor(opts: WoFailureCountStoreOptions = {}) {
    this.filePath = opts.path ?? DEFAULT_PATH;
    // Bug 0.8.90 M1: explicit `cap: 0` / `ttlMs: 0` are honoured here
    // (test injection point). `??` operator is correct vs `||` because
    // `0` is the explicit kill-switch value, not "missing".
    this.cap = opts.cap ?? parseTimeoutCapEnv();
    this.ttlMs = opts.ttlMs ?? parseEntryTtlEnv();
    this.now = opts.now ?? Date.now;
  }

  /**
   * Read the persisted file and prune expired entries. Idempotent —
   * subsequent calls reuse the in-memory cache. Returns an empty store
   * on any read/parse failure (P22 — never crash the WO loop on
   * persistence errors).
   */
  private load(): FailureFile {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // File doesn't exist or unreadable — start fresh.
      this.cache = { version: 1, entries: {} };
      return this.cache;
    }
    let parsed: FailureFile;
    try {
      parsed = JSON.parse(raw) as FailureFile;
    } catch (err) {
      logger.warn(`[WoFailureCount] failed to parse ${this.filePath}: ${(err as Error).message} — resetting`);
      this.cache = { version: 1, entries: {} };
      return this.cache;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.entries) {
      this.cache = { version: 1, entries: {} };
      return this.cache;
    }

    // Prune expired entries. Bug 0.8.90 M1: ttlMs === 0 means TTL is
    // disabled — entries persist until explicitly cleared. This pairs
    // with the same env=0 semantics on the cap (P31 reviewer-lesson —
    // env clamp consistency across the feature).
    if (this.ttlMs === 0) {
      this.cache = { version: 1, entries: parsed.entries };
      return this.cache;
    }
    const cutoff = this.now() - this.ttlMs;
    const pruned: Record<string, FailureEntry> = {};
    let prunedCount = 0;
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (entry.updatedAt >= cutoff) {
        pruned[id] = entry;
      } else {
        prunedCount++;
      }
    }
    if (prunedCount > 0) {
      logger.info(`[WoFailureCount] pruned ${prunedCount} expired entries (TTL=${this.ttlMs}ms)`);
    }
    this.cache = { version: 1, entries: pruned };
    return this.cache;
  }

  /**
   * Atomic-write the file: write to tmp + rename. rename is atomic on
   * POSIX filesystems so a crash mid-write leaves the previous file
   * intact instead of producing a half-written corrupt file (P3
   * reviewer-lesson family — correctness preserved across crashes).
   */
  private save(): void {
    const file = this.load();
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort; the writeFile below will surface real errors.
    }
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${this.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(file), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.warn(`[WoFailureCount] failed to persist ${this.filePath}: ${(err as Error).message}`);
      // Best-effort cleanup of tmp file if rename failed.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * Returns the current consecutive-timeout count for `workOrderId`,
   * 0 if never failed.
   */
  getCount(workOrderId: string): number {
    const file = this.load();
    return file.entries[workOrderId]?.count ?? 0;
  }

  /**
   * Returns true if this WO has hit the failure cap and should be locally
   * skipped. The pre-fetch filter in FetchWorkOrdersNode calls this on
   * every WO before accepting.
   *
   * Bug 0.8.90 M1 (P31 reviewer-lesson — env clamp): `cap === 0` is the
   * explicit "feature disabled" signal — never skip regardless of how
   * many failures the WO has accumulated. Counter still increments so
   * operators can inspect the file for diagnostics.
   */
  shouldSkip(workOrderId: string): boolean {
    if (this.cap === 0) return false;
    return this.getCount(workOrderId) >= this.cap;
  }

  /**
   * Increment the failure counter for this WO. Persists immediately.
   * `reason` is stored verbatim for operator diagnostics (e.g.
   * `obabel-gen3d-timeout` or `vina-timeout`).
   */
  markFailedTimeout(workOrderId: string, reason: string): { count: number; cappedNow: boolean } {
    const file = this.load();
    const current = file.entries[workOrderId];
    const newCount = (current?.count ?? 0) + 1;
    file.entries[workOrderId] = {
      count: newCount,
      updatedAt: this.now(),
      reason,
    };
    this.save();
    const cappedNow = newCount === this.cap;
    if (cappedNow) {
      logger.warn(
        `[WoFailureCount] WO ${workOrderId} reached failure cap (${newCount}/${this.cap}, reason=${reason}) — will be locally skipped`,
      );
    }
    return { count: newCount, cappedNow };
  }

  /**
   * Drop the failure entry for this WO. Called after a successful
   * completion so a one-off failure doesn't penalize future runs of the
   * same WO id (rare in production — WO ids are mostly unique — but
   * cheap correctness).
   */
  clear(workOrderId: string): void {
    const file = this.load();
    if (file.entries[workOrderId]) {
      delete file.entries[workOrderId];
      this.save();
    }
  }

  /**
   * Test-only: reset the in-memory cache so a freshly-written file is
   * re-read on next access. Production code never calls this.
   */
  __resetCacheForTests(): void {
    this.cache = null;
  }
}

/**
 * Module-level singleton wired into the agent loop. Tests use the class
 * constructor directly to inject a temp file path + clock.
 */
let singleton: WoFailureCountStore | null = null;

export function getWoFailureCountStore(): WoFailureCountStore {
  if (!singleton) singleton = new WoFailureCountStore();
  return singleton;
}

/**
 * Test-only: reset the singleton so each test starts from a clean store.
 */
export function __resetWoFailureCountSingletonForTests(): void {
  singleton = null;
}
