/**
 * BackpressureService — limits concurrent in-flight work orders to prevent
 * resource starvation. Guards both the legacy loop and LangGraph paths.
 *
 * Configuration: MAX_CONCURRENT_WORK_ORDERS env var (default: 2).
 */

import { Injectable } from '@nestjs/common';
import logger from '../../../utils/logger';

@Injectable()
export class BackpressureService {
  private readonly maxConcurrent: number;
  private readonly inFlight = new Set<string>();

  constructor() {
    this.maxConcurrent = parseInt(
      process.env.MAX_CONCURRENT_WORK_ORDERS ?? '2',
      10,
    );
    if (this.maxConcurrent < 1) {
      throw new Error(
        `MAX_CONCURRENT_WORK_ORDERS must be >= 1, got ${this.maxConcurrent}`,
      );
    }
  }

  /** Returns true if the node can accept another work order. */
  canAccept(): boolean {
    return this.inFlight.size < this.maxConcurrent;
  }

  /**
   * Try to acquire a slot for the given work order.
   * Returns true if the slot was acquired, false if at capacity.
   * Idempotent: acquiring the same ID twice is a no-op (returns true).
   */
  acquire(workOrderId: string): boolean {
    if (this.inFlight.has(workOrderId)) {
      return true;
    }
    if (this.inFlight.size >= this.maxConcurrent) {
      logger.warn(
        `[Backpressure] Rejected WO ${workOrderId} — at capacity ` +
          `(${this.inFlight.size}/${this.maxConcurrent})`,
      );
      return false;
    }
    this.inFlight.add(workOrderId);
    logger.log(
      `[Backpressure] Acquired slot for WO ${workOrderId} ` +
        `(${this.inFlight.size}/${this.maxConcurrent})`,
    );
    return true;
  }

  /** Release the slot for a completed/failed work order. */
  release(workOrderId: string): void {
    if (this.inFlight.delete(workOrderId)) {
      logger.log(
        `[Backpressure] Released slot for WO ${workOrderId} ` +
          `(${this.inFlight.size}/${this.maxConcurrent})`,
      );
    }
  }

  /** Current number of in-flight work orders. */
  getInFlight(): number {
    return this.inFlight.size;
  }

  /** Maximum allowed concurrent work orders. */
  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Returns the set of in-flight work order IDs (snapshot). */
  getInFlightIds(): ReadonlySet<string> {
    return new Set(this.inFlight);
  }
}
