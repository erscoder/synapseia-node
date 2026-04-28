/**
 * TelemetryClient — node-side ring buffer + sanitizer + flusher that
 * ships structured events to the coordinator's POST /telemetry/events.
 *
 * Lifecycle:
 *   1. Caller invokes `emit(ev)` (typed via event-builder factories).
 *   2. The event is sanitized and pushed onto an in-memory ring (cap
 *      1000). Overflow → oldest 100 spill to disk-spool.
 *   3. The flusher fires every FLUSH_INTERVAL_MS (30 s) OR when the
 *      ring crosses FLUSH_THRESHOLD (50). It drains up to 50 from the
 *      ring + 50 from the disk-spool head, builds a batch, signs it
 *      with the wallet, and POSTs to /telemetry/events.
 *   4. Retries: exponential backoff on 5xx / network. After 3
 *      consecutive failures the in-flight batch is pushed onto disk-
 *      spool and the cycle restarts.
 *   5. Idempotent: each event carries a uuid clientEventId. The
 *      coordinator dedups via UNIQUE (nodeId, clientEventId).
 *
 * The class is framework-agnostic — Nest DI just wraps it. Tests can
 * instantiate directly.
 */

import { Injectable, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { logger, setLoggerTap } from '../../utils/logger';
import { sanitizeEvent } from './sanitizer';
import { DiskSpool } from './disk-spool';
import {
  TelemetryEventInput,
  makeSubsystemErrorEvent,
  makeSubsystemWarningEvent,
  HwFingerprint,
} from './event-builder';

const RING_CAPACITY = 1000;
const RING_OVERFLOW_SPILL = 100;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 50;
const FLUSH_BATCH_MAX = 50;
const SPOOL_DRAIN_MAX = 50;
const MAX_FAILURES_BEFORE_SPOOL = 3;

export interface TelemetryClientOptions {
  /** libp2p peer id of this node — included in the body. */
  peerId: string;
  /** Synapseia version string (e.g. "0.7.3"). */
  appVersion: string;
  /** Coordinator base URL, e.g. http://coordinator:3001. */
  coordinatorUrl: string;
  /** Hardware fingerprint snapshot for default-attached events. */
  hwFingerprint: HwFingerprint;
  /**
   * Auth-header builder. Same shape as utils/node-auth.ts
   * `buildAuthHeaders` — provided here as a function so tests can
   * stub it without polyfilling crypto.
   */
  buildAuthHeaders: (params: {
    method: string;
    path: string;
    body: unknown;
  }) => Promise<Record<string, string>>;
  /** Optional override for tests. */
  diskSpool?: DiskSpool;
  /** Optional clock override for tests (defaults to setInterval). */
  scheduler?: Scheduler;
  /** Disable the auto-attached logger tap (default: enabled). */
  disableLoggerTap?: boolean;
}

export interface Scheduler {
  setInterval(handler: () => void, ms: number): NodeJS.Timeout | number;
  clearInterval(token: NodeJS.Timeout | number): void;
}

const DEFAULT_SCHEDULER: Scheduler = {
  setInterval: (h, ms) => setInterval(h, ms),
  clearInterval: t => clearInterval(t as NodeJS.Timeout),
};

interface IngestResponse {
  accepted: number;
  dropped: number;
  results: Array<{ clientEventId: string; status: string }>;
}

@Injectable()
export class TelemetryClient {
  private readonly ring: TelemetryEventInput[] = [];
  private readonly spool: DiskSpool;
  private readonly scheduler: Scheduler;
  private timer: NodeJS.Timeout | number | null = null;
  private flushing = false;
  private consecutiveFailures = 0;
  private readonly options: TelemetryClientOptions;

  constructor(
    @Optional() private readonly httpService: HttpService | null,
    options?: TelemetryClientOptions,
  ) {
    if (!options) {
      // When constructed via Nest DI without options, the caller MUST
      // call `configure()` before `start()`. This pattern keeps the
      // class injectable while giving the runtime a chance to compute
      // peerId / hardware lazily.
      this.options = {} as TelemetryClientOptions;
    } else {
      this.options = options;
    }
    this.spool = options?.diskSpool ?? new DiskSpool();
    this.scheduler = options?.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** Late binding of options for the Nest-DI'd path. */
  configure(options: TelemetryClientOptions): void {
    Object.assign(this.options, options);
  }

  /** Begin the flush loop and attach the logger tap. */
  start(): void {
    if (!this.options.disableLoggerTap) {
      setLoggerTap((level, args) => this.onLoggerEvent(level, args));
    }
    this.timer = this.scheduler.setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  /** Stop the flush loop and detach the tap. Safe to call multiple times. */
  stop(): void {
    if (this.timer != null) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    setLoggerTap(null);
  }

  /** Push an event onto the ring. Overflow spills to disk. */
  emit(ev: TelemetryEventInput): void {
    const cleaned = sanitizeEvent(ev);
    if (!cleaned) {
      // Oversize after sanitization — drop with a local warn (NOT via
      // logger.warn — that would re-enter through the tap and loop).
      // eslint-disable-next-line no-console
      console.warn(
        `[Telemetry] dropping oversized event ${ev.eventType} (${ev.clientEventId})`,
      );
      return;
    }
    this.ring.push(cleaned);
    if (this.ring.length > RING_CAPACITY) {
      const spill = this.ring.splice(0, RING_OVERFLOW_SPILL);
      this.spool.appendEvents(spill);
    }
    if (this.ring.length >= FLUSH_THRESHOLD && !this.flushing) {
      void this.flush();
    }
  }

  /**
   * Drain ring + spool head into a single batch and POST. Backs off
   * on failure. Returns the count of events the server accepted.
   */
  async flush(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      const fromRing = this.ring.splice(0, FLUSH_BATCH_MAX);
      const fromSpool = this.spool.drainHead(SPOOL_DRAIN_MAX) as TelemetryEventInput[];
      const batch = [...fromRing, ...fromSpool];
      if (batch.length === 0) {
        this.consecutiveFailures = 0;
        return 0;
      }

      const accepted = await this.postWithRetry(batch);
      if (accepted > 0) this.consecutiveFailures = 0;
      return accepted;
    } finally {
      this.flushing = false;
    }
  }

  /** Flush + drop ring (used during process shutdown). */
  async drainAll(timeoutMs: number = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.ring.length > 0 && Date.now() < deadline) {
      try {
        await this.flush();
      } catch {
        break;
      }
    }
  }

  /** Test hook — current ring length. */
  ringSize(): number {
    return this.ring.length;
  }

  /**
   * POST a batch once. On failure, count it and either re-queue to
   * the ring (transient) or spool to disk (≥ MAX_FAILURES_BEFORE_SPOOL
   * consecutive failures). The outer setInterval (FLUSH_INTERVAL_MS)
   * provides the retry cadence — no inner backoff loop.
   */
  private async postWithRetry(batch: TelemetryEventInput[]): Promise<number> {
    try {
      return await this.postOnce(batch);
    } catch (err) {
      const lastErr = err as Error;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= MAX_FAILURES_BEFORE_SPOOL) {
        this.spool.appendEvents(batch);
      } else {
        // Re-queue at the head of the ring so the next interval retries.
        this.ring.unshift(...batch);
      }
      // Don't go through the tap (would loop); use raw console.
      // eslint-disable-next-line no-console
      console.warn(
        `[Telemetry] flush failed (consecutive=${this.consecutiveFailures}): ${lastErr.message}`,
      );
      return 0;
    }
  }

  private async postOnce(batch: TelemetryEventInput[]): Promise<number> {
    if (!this.options.peerId || !this.options.coordinatorUrl) {
      // Not configured yet — push back and try later.
      this.ring.unshift(...batch);
      return 0;
    }
    const path = '/telemetry/events';
    const body = {
      peerId: this.options.peerId,
      appVersion: this.options.appVersion,
      events: batch,
    };
    const headers = await this.options.buildAuthHeaders({
      method: 'POST',
      path,
      body,
    });

    if (this.httpService) {
      const res = await lastValueFrom(
        this.httpService.post<IngestResponse>(path, body, {
          baseURL: this.options.coordinatorUrl,
          timeout: 15_000,
          headers: { 'Content-Type': 'application/json', ...headers },
        }),
      );
      return res.data?.accepted ?? batch.length;
    }
    // CLI / test path — raw fetch.
    const res = await fetch(`${this.options.coordinatorUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`telemetry POST failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as IngestResponse;
    return json?.accepted ?? batch.length;
  }

  /** Logger tap callback — produces subsystem.error / .warning events. */
  private onLoggerEvent(level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]): void {
    if (level === 'debug' || level === 'info') return;
    if (!this.options.hwFingerprint) return; // not configured yet
    const ev =
      level === 'error'
        ? makeSubsystemErrorEvent(this.options.hwFingerprint, args)
        : makeSubsystemWarningEvent(this.options.hwFingerprint, args);
    this.emit(ev);
  }
}

/** Exposed for callers / tests that want to know the limits. */
export const TELEMETRY_LIMITS = {
  RING_CAPACITY,
  RING_OVERFLOW_SPILL,
  FLUSH_INTERVAL_MS,
  FLUSH_THRESHOLD,
  FLUSH_BATCH_MAX,
  MAX_FAILURES_BEFORE_SPOOL,
};

/* ───────────────── Global singleton handle ─────────────────
 * The cli/index.ts process-level error handlers fire BEFORE Nest's DI
 * graph is available (and from contexts where DI cannot reach). They
 * still need a way to push exception telemetry. node-runtime.ts calls
 * `setGlobalTelemetryClient(client)` after configuring the Nest-owned
 * client; the handlers reach for it through `getGlobalTelemetryClient()`
 * — best effort, no-throw if not yet set.
 */
let globalClient: TelemetryClient | null = null;

export function setGlobalTelemetryClient(client: TelemetryClient | null): void {
  globalClient = client;
}

export function getGlobalTelemetryClient(): TelemetryClient | null {
  return globalClient;
}
