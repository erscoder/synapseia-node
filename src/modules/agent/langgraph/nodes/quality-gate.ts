import { Injectable } from '@nestjs/common';
import { WorkOrderEvaluationHelper } from '../../work-order/work-order.evaluation';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

const SUBMISSION_RATE_LIMIT_MS = parseInt(process.env.SUBMISSION_RATE_LIMIT_MS ?? String(10_000), 10);
const SUBMISSION_MIN_SCORE = parseFloat(process.env.SUBMISSION_MIN_SCORE ?? '0.30');

@Injectable()
export class QualityGateNode {
  constructor(
    private readonly execution: WorkOrderExecutionHelper,
    private readonly evaluation: WorkOrderEvaluationHelper,
  ) {}


  private lastSubmissionAt = 0;

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, executionResult, researchResult } = state;

    // Research WOs: executionResult is not set (produced by executor nodes, not research pipeline)
    // For research, success means researchResult exists and has quality score
    const isResearch = selectedWorkOrder && this.execution.isResearchWorkOrder(selectedWorkOrder);
    if (!isResearch && !executionResult?.success) {
      logger.warn(' QualityGate: execution failed — skipping submission');
      return { qualityScore: 0, shouldSubmit: false };
    }

    // For research WOs, check quality via research result
    if (isResearch && researchResult) {
      const score = this.evaluation.scoreResearchResult(researchResult);
      if (score < SUBMISSION_MIN_SCORE) {
        logger.warn(` Research score ${score.toFixed(4)} < ${SUBMISSION_MIN_SCORE} — skipping`);
        return { qualityScore: score, shouldSubmit: false };
      }
      logger.log(` Research quality score: ${score.toFixed(4)}`);
    }

    const now = Date.now();
    const jitterMs = Math.floor(Math.random() * SUBMISSION_RATE_LIMIT_MS);
    const nextAllowedAt = this.lastSubmissionAt + SUBMISSION_RATE_LIMIT_MS + jitterMs;
    if (now < nextAllowedAt) {
      const waitMs = nextAllowedAt - now;
      logger.log(` Rate limit: waiting ${(waitMs / 1000).toFixed(1)}s`);
      await this.sleep(waitMs);
    }
    this.lastSubmissionAt = Date.now();

    return {
      qualityScore: researchResult ? this.evaluation.scoreResearchResult(researchResult) : 1.0,
      shouldSubmit: true,
    };
  }

  resetRateLimit(): void {
    this.lastSubmissionAt = 0;
  }

  getLastSubmissionTime(): number {
    return this.lastSubmissionAt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
