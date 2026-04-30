/**
 * circuit-breaker.ts — small synchronous-state circuit breaker.
 *
 * Use to suppress retry storms against an unhealthy dependency
 * (e.g. Ollama crashing under RAM pressure). When N consecutive
 * failures fire within `windowMs`, the breaker opens for
 * `cooldownMs`; calls during the open window throw
 * `CircuitOpenError` *without* invoking the underlying op, so the
 * caller never logs another `Generation failed: ...` line.
 *
 * After cooldown the breaker enters half-open and admits exactly
 * one probe; success closes it, failure re-opens it for another
 * full cooldown.
 *
 * Zero dependencies, ~80 lines.
 */
import logger from './logger';

export class CircuitOpenError extends Error {
  constructor(name: string, public readonly retryAfterMs: number) {
    super(`circuit "${name}" open — retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Friendly identifier (used in logs and CircuitOpenError). */
  name: string;
  /** Failures within `windowMs` that trip the breaker. */
  failureThreshold: number;
  /** Sliding window for counting failures (ms). */
  windowMs: number;
  /** How long the breaker stays open before half-open probe (ms). */
  cooldownMs: number;
}

type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: State = 'closed';
  private failures: number[] = [];   // Unix-ms timestamps within the window
  private openedAt = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /**
   * Run `op` under breaker control. Throws `CircuitOpenError` immediately
   * when open; otherwise propagates the underlying success/failure.
   */
  async exec<T>(op: () => Promise<T>): Promise<T> {
    const now = Date.now();

    if (this.state === 'open') {
      const elapsed = now - this.openedAt;
      if (elapsed < this.opts.cooldownMs) {
        throw new CircuitOpenError(this.opts.name, this.opts.cooldownMs - elapsed);
      }
      // Cooldown elapsed → admit one probe.
      this.state = 'half-open';
    }

    try {
      const result = await op();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(now);
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state !== 'closed') {
      logger.warn(`[circuit:${this.opts.name}] recovered — closing`);
    }
    this.state = 'closed';
    this.failures = [];
  }

  private onFailure(now: number): void {
    if (this.state === 'half-open') {
      // Probe failed — re-open for another full cooldown.
      this.openedAt = now;
      this.state = 'open';
      logger.warn(`[circuit:${this.opts.name}] probe failed — reopening for ${this.opts.cooldownMs}ms`);
      return;
    }

    // Drop failures older than the window.
    const cutoff = now - this.opts.windowMs;
    this.failures = this.failures.filter(t => t >= cutoff);
    this.failures.push(now);

    if (this.failures.length >= this.opts.failureThreshold) {
      this.openedAt = now;
      this.state = 'open';
      this.failures = [];
      logger.warn(
        `[circuit:${this.opts.name}] tripped — ${this.opts.failureThreshold} failures in ${this.opts.windowMs}ms; opening for ${this.opts.cooldownMs}ms`,
      );
    }
  }

  /** Test-only / introspection. */
  getState(): State { return this.state; }
}
