/**
 * Circuit Breaker Service
 * Sprint E — A2A Client for Synapseia Node
 *
 * Prevents repeated requests to failing peers using the circuit breaker pattern.
 * States: closed (normal) → open (failing) → half-open (testing recovery)
 */

import { Injectable } from '@nestjs/common';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitInfo {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  nextRetry: number;
}

@Injectable()
export class CircuitBreakerService {
  private readonly FAILURE_THRESHOLD = 3;
  private readonly OPEN_DURATION_MS = 10 * 60 * 1000; // 10 minutes
  private readonly circuits = new Map<string, CircuitInfo>();

  /**
   * Returns true if circuit is open (fast-fail, no request attempted).
   * Transitions open → half-open when retry time has elapsed.
   */
  isOpen(targetUrl: string): boolean {
    const circuit = this.circuits.get(targetUrl);
    if (!circuit) return false;

    if (circuit.state === 'open') {
      // Check if we should try half-open
      if (Date.now() >= circuit.nextRetry) {
        circuit.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Record a successful request — resets the circuit.
   */
  recordSuccess(targetUrl: string): void {
    this.circuits.delete(targetUrl); // reset on success
  }

  /**
   * Record a failed request — may trip the circuit open.
   */
  recordFailure(targetUrl: string): void {
    const circuit = this.circuits.get(targetUrl) ?? {
      state: 'closed' as CircuitState,
      failures: 0,
      lastFailure: 0,
      nextRetry: 0,
    };

    circuit.failures++;
    circuit.lastFailure = Date.now();

    if (circuit.failures >= this.FAILURE_THRESHOLD) {
      circuit.state = 'open';
      circuit.nextRetry = Date.now() + this.OPEN_DURATION_MS;
    }

    this.circuits.set(targetUrl, circuit);
  }

  /**
   * Get the current state of a circuit.
   */
  getState(targetUrl: string): CircuitState {
    return this.circuits.get(targetUrl)?.state ?? 'closed';
  }

  /**
   * Reset a circuit manually (admin use).
   */
  reset(targetUrl: string): void {
    this.circuits.delete(targetUrl);
  }

  /**
   * Reset all circuits.
   */
  resetAll(): void {
    this.circuits.clear();
  }

  /**
   * Get the number of tracked circuits.
   */
  getSize(): number {
    return this.circuits.size;
  }
}
