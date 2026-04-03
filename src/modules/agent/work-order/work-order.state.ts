/**
 * WorkOrderStateHelper — manages agent state and loop control helpers.
 * Stateful: owns agentState and lastSubmissionAt.
 */

import { Injectable } from '@nestjs/common';
import logger from '../../../utils/logger';
import type { WorkOrder, WorkOrderAgentState } from './work-order.types';

@Injectable()
export class WorkOrderStateHelper {
  private agentState: WorkOrderAgentState = {
    iteration: 0,
    totalWorkOrdersCompleted: 0,
    totalRewardsEarned: 0n,
    isRunning: false,
    completedWorkOrderIds: new Set<string>(),
    researchCooldowns: new Map<string, number>(),
  };

  private lastSubmissionAt = 0;
  /** Last WO type accepted — used for round-robin type rotation */
  lastAcceptedType: string | null = null;
  /** How many times each type has been executed this session */
  readonly typeExecutionCount: Map<string, number> = new Map();

  private readonly researchCooldownMs = parseInt(
    process.env.RESEARCH_COOLDOWN_MS ?? String(5 * 60 * 1000),
    10,
  );

  private readonly submissionMinScore = parseFloat(
    process.env.SUBMISSION_MIN_SCORE ?? '0.1',
  );

  private readonly submissionRateLimitMs = parseInt(
    process.env.SUBMISSION_RATE_LIMIT_MS ?? String(60 * 1000),
    10,
  );

  getState(): WorkOrderAgentState {
    return { ...this.agentState };
  }

  resetState(): void {
    this.agentState = {
      iteration: 0,
      totalWorkOrdersCompleted: 0,
      totalRewardsEarned: 0n,
      isRunning: false,
      completedWorkOrderIds: new Set<string>(),
      researchCooldowns: new Map<string, number>(),
    };
    this.lastSubmissionAt = 0;
    this.lastAcceptedType = null;
    this.typeExecutionCount.clear();
  }

  get isRunning(): boolean {
    return this.agentState.isRunning;
  }

  set isRunning(val: boolean) {
    this.agentState.isRunning = val;
  }

  get currentWorkOrder(): WorkOrder | undefined {
    return this.agentState.currentWorkOrder;
  }

  set currentWorkOrder(wo: WorkOrder | undefined) {
    this.agentState.currentWorkOrder = wo;
  }

  get iteration(): number {
    return this.agentState.iteration;
  }

  set iteration(val: number) {
    this.agentState.iteration = val;
  }

  get totalWorkOrdersCompleted(): number {
    return this.agentState.totalWorkOrdersCompleted;
  }

  incrementCompleted(): void {
    this.agentState.totalWorkOrdersCompleted++;
  }

  addRewards(lamports: bigint): void {
    this.agentState.totalRewardsEarned += lamports;
  }

  isCompleted(workOrderId: string): boolean {
    return this.agentState.completedWorkOrderIds.has(workOrderId);
  }

  markCompleted(workOrderId: string): void {
    this.agentState.completedWorkOrderIds.add(workOrderId);
  }

  isOnCooldown(workOrderId: string): boolean {
    const cooldownUntil = this.agentState.researchCooldowns.get(workOrderId);
    return !!(cooldownUntil && Date.now() < cooldownUntil);
  }

  getCooldownRemainingSec(workOrderId: string): number {
    const cooldownUntil = this.agentState.researchCooldowns.get(workOrderId);
    if (!cooldownUntil) return 0;
    return Math.ceil((cooldownUntil - Date.now()) / 1000);
  }

  setCooldown(workOrderId: string): void {
    this.agentState.researchCooldowns.set(workOrderId, Date.now() + this.researchCooldownMs);
    logger.log(` Research paper will be available for re-analysis in ${this.researchCooldownMs / 1000}s`);
  }

  /** Returns false (and logs) if rate limit is active. Otherwise updates lastSubmissionAt. */
  async checkRateLimit(): Promise<void> {
    const jitterMs = Math.floor(Math.random() * this.submissionRateLimitMs);
    const nextAllowedAt = this.lastSubmissionAt + this.submissionRateLimitMs + jitterMs;
    const now = Date.now();
    if (now < nextAllowedAt) {
      const waitMs = nextAllowedAt - now;
      logger.log(` Rate limit: waiting ${(waitMs / 1000).toFixed(1)}s before submitting (jitter: ${(jitterMs / 1000).toFixed(1)}s)`);
      await this.sleep(waitMs);
    }
    this.lastSubmissionAt = Date.now();
  }

  get submissionMinScoreThreshold(): number {
    return this.submissionMinScore;
  }

  parseSynToLamports(rewardStr: string): bigint {
    if (!rewardStr) return 0n;
    if (!rewardStr.includes('.')) return BigInt(rewardStr);
    const [intPart, decPart = ''] = rewardStr.split('.');
    const decimals = 9;
    const paddedDec = decPart.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(intPart) * 1_000_000_000n + BigInt(paddedDec);
  }

  shouldContinueLoop(isRunning: boolean, iteration: number, maxIterations?: number): boolean {
    if (!isRunning) return false;
    if (maxIterations && iteration > maxIterations) return false;
    return true;
  }

  shouldStopForMaxIterations(iteration: number, maxIterations?: number): boolean {
    if (!maxIterations) return false;
    return iteration > maxIterations;
  }

  shouldSleepBetweenIterations(isRunning: boolean): boolean {
    return isRunning;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
