/**
 * Bug 0.8.90 BLOCKER (2026-05-18) — SubmitResultNode quality gate scope.
 *
 * Verified live 2026-05-18 19:01-19:14Z on pod 213 (node 0.8.89):
 *   wo_training_1779109561108_fc0e5f62  (TRAINING)        → gate rejected
 *   wo_diloco_1779126050262_57df2e77    (DILOCO_TRAINING) → gate rejected
 * Both completed execution OK but `/complete` POST was skipped because the
 * 0.8.89 gate called `this.execution.isResearchWorkOrder(...)`, which falls
 * back to `extractResearchPayload(workOrder) !== null` — and that helper
 * returns truthy for any WO with `title` + `description` (i.e. all WOs).
 *
 * 0.8.90 fix: strict `wo.type === 'RESEARCH'` literal check at the gate
 * site, decoupled from the routing helper.
 *
 * Test contract (P29 — exercise the REAL path, not a mocked one):
 *   - The `execution` mock here uses the SAME fallback shape as the live
 *     helper (returns true for any non-RESEARCH WO that has title +
 *     description). This proves the production gate now bypasses the
 *     buggy helper rather than relying on its return value.
 *   - For each WO type the spec asserts that `completeWorkOrder` IS
 *     called even with empty research-shaped fields in `executionResult`.
 *   - RESEARCH WOs continue to be gated (regression check vs Bug 31).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SubmitResultNode } from '../submit-result';
import logger from '../../../../../utils/logger';

describe('SubmitResultNode — Bug 0.8.90 quality gate scope (BLOCKER)', () => {
  let coordinator: any;
  let fetchNode: any;
  let execution: any;
  let node: SubmitResultNode;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;

  function makeWO(type: string) {
    return {
      id: `wo-${type.toLowerCase()}-1`,
      title: 't',
      description: 'd',
      requiredCapabilities: ['cpu_inference'],
      rewardAmount: '1',
      status: 'ACCEPTED',
      creatorAddress: 'c',
      createdAt: 0,
      type,
    } as any;
  }

  const baseState: any = {
    selectedWorkOrder: null,
    executionResult: null,
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    walletAddress: 'wallet-1',
    completedWorkOrderIds: [],
    iteration: 0,
  };

  beforeEach(() => {
    coordinator = {
      getWorkOrder: jest.fn().mockResolvedValue({ status: 'ACCEPTED' }),
      completeWorkOrder: jest.fn().mockResolvedValue(true),
    };
    fetchNode = {
      markCompleted: jest.fn(),
      markFailedTimeout: jest.fn().mockReturnValue({ count: 1, cappedNow: false }),
    };
    // P29 — model the BUGGY fallback shape of `isResearchWorkOrder` from
    // `work-order.execution.ts:51-54`. The helper returns true if
    // `extractResearchPayload(wo) !== null`, and `extractResearchPayload`
    // returns truthy for any WO with `title` + `description`. So this
    // mock returns true for ANY WO — same as the live helper bug.
    // If the new code in submit-result.ts mistakenly trusts the helper
    // again, ALL these tests will fail with a rejected gate.
    execution = {
      isResearchWorkOrder: jest.fn().mockImplementation((wo: any) =>
        Boolean(wo?.title && wo?.description),
      ),
      isDockingWorkOrder: jest.fn((wo: any) => wo?.type === 'MOLECULAR_DOCKING'),
    };
    node = new SubmitResultNode(coordinator, fetchNode, execution);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    infoSpy.mockRestore();
  });

  const nonResearchTypes = [
    'TRAINING',
    'DILOCO_TRAINING',
    'LORA_TRAINING',
    'LORA_VALIDATION',
    'MOLECULAR_DOCKING',
    'CPU_INFERENCE',
    'GPU_INFERENCE',
  ] as const;

  for (const t of nonResearchTypes) {
    it(`bypasses the research quality gate for type=${t} (empty research fields OK)`, async () => {
      const wo = makeWO(t);
      const state = {
        ...baseState,
        selectedWorkOrder: wo,
        executionResult: {
          success: true,
          // Empty research-shaped payload — would trigger
          // `empty_payload` reason if the gate fired.
          result: JSON.stringify({}),
        },
      };
      const out = await node.execute(state);

      // The POST must happen — coord is the authoritative validator for
      // these types via DockingSubmissionService / LoRA / training-loss.
      expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
      expect(out.submitted).toBe(true);
      // The reject-log must NOT appear.
      const rejectLog = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('Local quality gate rejected'));
      expect(rejectLog).toBeUndefined();
    });
  }

  it('bypasses the gate when wo.type is undefined (P22 fail-open for unknown types)', async () => {
    const wo = makeWO('TRAINING');
    delete wo.type;
    const state = {
      ...baseState,
      selectedWorkOrder: wo,
      executionResult: {
        success: true,
        result: JSON.stringify({}),
      },
    };
    const out = await node.execute(state);
    expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
    expect(out.submitted).toBe(true);
  });

  it('handles case-variant `research` (defensive uppercase normalization)', async () => {
    // The wire format is `RESEARCH` per `WorkOrder.type` enum but defending
    // against drift cheaply — the strict literal check uses uppercase
    // comparison so any future case-variant still triggers the gate.
    const wo = makeWO('research' as any);
    const state = {
      ...baseState,
      selectedWorkOrder: wo,
      executionResult: {
        success: true,
        result: JSON.stringify({}), // empty → should be rejected
      },
    };
    const out = await node.execute(state);
    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(out.submitted).toBe(false);
    const rejectLog = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('Local quality gate rejected'));
    expect(rejectLog).toBeDefined();
  });

  it('regression vs Bug 31 — RESEARCH WO with bare-`{` summary still rejected', async () => {
    const wo = makeWO('RESEARCH');
    const state = {
      ...baseState,
      selectedWorkOrder: wo,
      executionResult: {
        success: true,
        result: JSON.stringify({ summary: '{', keyInsights: [], proposal: '' }),
      },
    };
    const out = await node.execute(state);
    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(out.submitted).toBe(false);
  });

  it('regression vs Bug 31 — admissible RESEARCH WO still POSTs', async () => {
    const wo = makeWO('RESEARCH');
    const goodSummary =
      'Riluzole at 50mg twice daily extends median ALS survival by approximately three months versus placebo across replications.';
    const state = {
      ...baseState,
      selectedWorkOrder: wo,
      executionResult: {
        success: true,
        result: JSON.stringify({
          summary: goodSummary,
          keyInsights: ['Replicated 3-month survival extension'],
          proposal: 'Test riluzole in a new ALS cohort with 12-week dosing.',
        }),
      },
    };
    const out = await node.execute(state);
    expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
    expect(out.submitted).toBe(true);
  });
});
