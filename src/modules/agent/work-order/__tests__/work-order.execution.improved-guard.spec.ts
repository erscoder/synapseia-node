/**
 * Reviewer M2 — improved-guard contract for executeTrainingWorkOrder.
 *
 * The executor wraps trainer output in a 4-layer guard before it reaches
 * the coordinator submission JSON. This guard is reward-payout-critical:
 * if it leaks `improved=true` on a degraded trainer result, a node gets
 * paid for "improvement" that never happened.
 *
 *   improved =
 *     !valLossEvalFailed &&
 *     valLoss > 0 &&
 *     valLoss < TRAINER_EVAL_FAILED_SENTINEL &&
 *     valLoss < currentBestLoss
 *
 * After H1 fix, `improved` and `valLossEvalFailed` are computed ONCE in
 * the executor and passed into `coordinator.submitTrainingResult` — the
 * coordinator no longer recomputes. These tests verify both the boolean
 * outcome AND the values forwarded to the coordinator submission.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { WorkOrderExecutionHelper } from '../work-order.execution';
import { WorkOrderCoordinatorHelper } from '../work-order.coordinator';
import { WorkOrderEvaluationHelper } from '../work-order.evaluation';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { TRAINER_EVAL_FAILED_SENTINEL } from '../../../model/trainer';
import type { WorkOrder, TrainingWorkOrderPayload } from '../work-order.types';

// Mock the trainer entry point. `var` (hoisted) lets the jest.mock factory
// reference it without TDZ errors.
var mockTrainMicroModel: jest.Mock<any>;
mockTrainMicroModel = jest.fn();

jest.mock('../../../model/trainer', () => {
  const actual = jest.requireActual<typeof import('../../../model/trainer')>(
    '../../../model/trainer',
  );
  return {
    ...actual,
    trainMicroModel: (...args: unknown[]) => mockTrainMicroModel(...args),
    // Re-export the constant so the test SUT (work-order.execution.ts)
    // still resolves it via the mocked module.
    TRAINER_EVAL_FAILED_SENTINEL: actual.TRAINER_EVAL_FAILED_SENTINEL,
  };
});

// Mock the mutation engine — its output is irrelevant for these tests but
// the executor calls it before training. Returning a deterministic config
// keeps the path straight to trainMicroModel.
jest.mock('../../../model/mutation-engine', () => {
  return {
    MutationEngineHelper: jest.fn().mockImplementation(() => ({
      proposeMutation: jest.fn().mockResolvedValue({
        model: { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' },
        type: 'explore',
        baseExperimentId: null,
        reasoning: 'test',
        hyperparams: {
          learningRate: 0.001,
          batchSize: 32,
          hiddenDim: 128,
          numLayers: 4,
          numHeads: 4,
          activation: 'gelu',
          normalization: 'layernorm',
          initScheme: 'xavier',
          warmupSteps: 100,
          weightDecay: 0.01,
          maxTrainSeconds: 30,
        },
      }),
    })),
    MutationEngineError: class MutationEngineError extends Error {
      attempts: unknown[] = [];
    },
  };
});

describe('WorkOrderExecutionHelper — improved-guard (Reviewer M2)', () => {
  let helper: WorkOrderExecutionHelper;
  let coordinator: WorkOrderCoordinatorHelper;
  let submitTrainingResultSpy: jest.SpiedFunction<
    WorkOrderCoordinatorHelper['submitTrainingResult']
  >;

  const buildPayload = (
    currentBestLoss: number,
  ): TrainingWorkOrderPayload => ({
    domain: 'medical',
    datasetId: 'medical-corpus',
    maxTrainSeconds: 30,
    currentBestLoss,
  });

  const buildWorkOrder = (payload: TrainingWorkOrderPayload): WorkOrder => ({
    id: 'wo-train-1',
    title: 'training-test',
    type: 'TRAINING',
    description: JSON.stringify(payload),
    requiredCapabilities: ['cpu_training'],
  } as unknown as WorkOrder);

  beforeEach(() => {
    coordinator = new WorkOrderCoordinatorHelper();
    const evaluation = new WorkOrderEvaluationHelper();
    const llmProvider = new LlmProviderHelper();
    helper = new WorkOrderExecutionHelper(coordinator, evaluation, llmProvider);

    // No-op all the network-touching coordinator helpers.
    jest
      .spyOn(coordinator, 'fetchTopExperiments')
      .mockResolvedValue([] as never);
    jest
      .spyOn(coordinator, 'downloadDataset')
      .mockResolvedValue('synthetic://built-in' as never);
    jest
      .spyOn(coordinator, 'submitTrainingExperiment')
      .mockResolvedValue(undefined as never);

    submitTrainingResultSpy = jest
      .spyOn(coordinator, 'submitTrainingResult')
      .mockResolvedValue(undefined as never);

    mockTrainMicroModel.mockReset();
  });

  it('valLossEvalFailed=true → improved=false; submission carries valLossEvalFailed=true', async () => {
    mockTrainMicroModel.mockResolvedValue({
      runNumber: 1,
      finalLoss: 0.5,
      valLoss: 0.5, // Numeric value would normally pass — boolean must override.
      improvementPercent: 0,
      durationMs: 1000,
      config: {},
      lossCurve: [],
      hardwareUsed: 'cpu',
      valLossEvalFailed: true,
      valLossEvalFailureReason: 'val_loader empty',
    });

    const result = await helper.executeTrainingWorkOrder(
      // Note: JSON.stringify renders Infinity as null, so we use
      // Number.MAX_VALUE — semantically equivalent for our `<` comparison
      // (any real loss is < MAX_VALUE) but JSON-round-trip safe.
      buildWorkOrder(buildPayload(Number.MAX_VALUE)),
      'http://coord',
      'peer-1',
      ['cpu_training'],
      0,
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.result) as {
      improved: boolean;
      valLossEvalFailed: boolean;
    };
    expect(parsed.improved).toBe(false);
    expect(parsed.valLossEvalFailed).toBe(true);

    // Coordinator was called with executor-computed flags (no recompute).
    expect(submitTrainingResultSpy).toHaveBeenCalledTimes(1);
    const args = submitTrainingResultSpy.mock.calls[0];
    expect(args[6]).toBe(false); // improved
    expect(args[7]).toBe(true); // valLossEvalFailed
  });

  it('valLoss=0 (legacy Python path) → improved=false even with low currentBestLoss', async () => {
    mockTrainMicroModel.mockResolvedValue({
      runNumber: 1,
      finalLoss: 0,
      valLoss: 0,
      improvementPercent: 0,
      durationMs: 1000,
      config: {},
      lossCurve: [],
      hardwareUsed: 'cpu',
      // No valLossEvalFailed flag — simulates legacy trainer build.
    });

    const result = await helper.executeTrainingWorkOrder(
      // Note: JSON.stringify renders Infinity as null, so we use
      // Number.MAX_VALUE — semantically equivalent for our `<` comparison
      // (any real loss is < MAX_VALUE) but JSON-round-trip safe.
      buildWorkOrder(buildPayload(Number.MAX_VALUE)),
      'http://coord',
      'peer-1',
      ['cpu_training'],
      0,
    );

    const parsed = JSON.parse(result.result) as {
      improved: boolean;
      valLossEvalFailed: boolean;
    };
    expect(parsed.improved).toBe(false);
    expect(parsed.valLossEvalFailed).toBe(false);
    expect(submitTrainingResultSpy.mock.calls[0][6]).toBe(false);
  });

  it('valLoss = TRAINER_EVAL_FAILED_SENTINEL → improved=false (sentinel rejected)', async () => {
    mockTrainMicroModel.mockResolvedValue({
      runNumber: 1,
      finalLoss: TRAINER_EVAL_FAILED_SENTINEL,
      valLoss: TRAINER_EVAL_FAILED_SENTINEL,
      improvementPercent: 0,
      durationMs: 1000,
      config: {},
      lossCurve: [],
      hardwareUsed: 'cpu',
      // No valLossEvalFailed flag — exercise the numeric SENTINEL guard
      // independently from the boolean guard.
    });

    const result = await helper.executeTrainingWorkOrder(
      // Note: JSON.stringify renders Infinity as null, so we use
      // Number.MAX_VALUE — semantically equivalent for our `<` comparison
      // (any real loss is < MAX_VALUE) but JSON-round-trip safe.
      buildWorkOrder(buildPayload(Number.MAX_VALUE)),
      'http://coord',
      'peer-1',
      ['cpu_training'],
      0,
    );

    const parsed = JSON.parse(result.result) as {
      improved: boolean;
      valLossEvalFailed: boolean;
    };
    // SENTINEL is NOT < SENTINEL → guard correctly rejects.
    expect(parsed.improved).toBe(false);
    expect(submitTrainingResultSpy.mock.calls[0][6]).toBe(false);
  });

  it('happy path: valLoss=0.5, currentBestLoss=Infinity, evalFailed=false → improved=true', async () => {
    mockTrainMicroModel.mockResolvedValue({
      runNumber: 1,
      finalLoss: 0.4,
      valLoss: 0.5,
      improvementPercent: 50,
      durationMs: 1000,
      config: {},
      lossCurve: [],
      hardwareUsed: 'cpu',
      valLossEvalFailed: false,
    });

    const result = await helper.executeTrainingWorkOrder(
      // Note: JSON.stringify renders Infinity as null, so we use
      // Number.MAX_VALUE — semantically equivalent for our `<` comparison
      // (any real loss is < MAX_VALUE) but JSON-round-trip safe.
      buildWorkOrder(buildPayload(Number.MAX_VALUE)),
      'http://coord',
      'peer-1',
      ['cpu_training'],
      0,
    );

    const parsed = JSON.parse(result.result) as {
      improved: boolean;
      valLossEvalFailed: boolean;
    };
    expect(parsed.improved).toBe(true);
    expect(parsed.valLossEvalFailed).toBe(false);
    expect(submitTrainingResultSpy.mock.calls[0][6]).toBe(true);
    expect(submitTrainingResultSpy.mock.calls[0][7]).toBe(false);
  });
});
