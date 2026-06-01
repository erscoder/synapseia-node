/**
 * Bug H1 — SubmitResultNode pre-submit status check.
 *
 * Verifies that the node:
 *   (a) skips POST + logs info when the WO is no longer ACCEPTED;
 *   (b) POSTs when status is still ACCEPTED;
 *   (c) POSTs when probe returns null (transient 404).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SubmitResultNode } from '../submit-result';
import logger from '../../../../../utils/logger';
import type { WorkOrder } from '../../../work-order/work-order.types';

describe('SubmitResultNode — pre-submit status check (Bug H1)', () => {
  let coordinator: {
    getWorkOrder: jest.Mock;
    completeWorkOrder: jest.Mock;
  };
  let fetchNode: { markCompleted: jest.Mock };
  let node: SubmitResultNode;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;

  const baseWO: WorkOrder = {
    id: 'wo-1',
    title: 't',
    description: 'd',
    requiredCapabilities: ['cpu_inference'],
    rewardAmount: '6000',
    status: 'ACCEPTED',
    creatorAddress: 'creator',
    createdAt: 0,
    type: 'DILOCO_TRAINING',
  };

  const baseState = {
    selectedWorkOrder: baseWO,
    executionResult: { success: true, result: 'ok' },
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    completedWorkOrderIds: [],
    iteration: 3,
  } as any;

  beforeEach(() => {
    coordinator = {
      getWorkOrder: jest.fn(),
      completeWorkOrder: jest.fn(),
    };
    fetchNode = { markCompleted: jest.fn(), markFailedTimeout: jest.fn() };
    // Bug 31 (2026-05-18) — SubmitResultNode now takes WorkOrderExecutionHelper
    // as a third dep for the client-side research-WO quality gate. Stub
    // `isResearchWorkOrder` to false here so the stale-WO test (TRAINING
    // shape) bypasses the gate; gate behaviour is covered separately.
    // Bug 0.8.90 L2 (P22 reviewer-lesson): also stub `isDockingWorkOrder`
    // so any future `success: false` test in this file doesn't crash with
    // "is not a function" when the failed-exec path probes the docking
    // type for timeout-counter increment.
    const execution = {
      isResearchWorkOrder: jest.fn().mockReturnValue(false),
      isDockingWorkOrder: jest.fn().mockReturnValue(false),
    };
    node = new SubmitResultNode(coordinator as any, fetchNode as any, execution as any);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('drops the result without POST when status is COMPLETED', async () => {
    coordinator.getWorkOrder.mockResolvedValue({ ...baseWO, status: 'COMPLETED' });

    const out = await node.execute(baseState);

    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(fetchNode.markCompleted).toHaveBeenCalledWith(baseWO);
    expect(out.submitted).toBe(true);
    expect(out.completedWorkOrderIds).toContain('wo-1');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping stale result for WO wo-1 (status=COMPLETED)'),
    );
  });

  it('drops the result without POST when status is VERIFIED', async () => {
    coordinator.getWorkOrder.mockResolvedValue({ ...baseWO, status: 'VERIFIED' });

    const out = await node.execute(baseState);

    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(out.submitted).toBe(true);
  });

  it('drops the result without POST when status is CANCELLED', async () => {
    coordinator.getWorkOrder.mockResolvedValue({ ...baseWO, status: 'CANCELLED' });

    const out = await node.execute(baseState);

    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(out.submitted).toBe(true);
  });

  it('proceeds to POST when status is ACCEPTED', async () => {
    coordinator.getWorkOrder.mockResolvedValue({ ...baseWO, status: 'ACCEPTED' });
    coordinator.completeWorkOrder.mockResolvedValue(true);

    const out = await node.execute(baseState);

    expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
    expect(out.submitted).toBe(true);
  });

  it('proceeds to POST when probe returns null (404 or network glitch)', async () => {
    coordinator.getWorkOrder.mockResolvedValue(null);
    coordinator.completeWorkOrder.mockResolvedValue(true);

    await node.execute(baseState);

    expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
  });

  it('still drops a non-research WO when probe status is PENDING (unchanged strict drop)', async () => {
    coordinator.getWorkOrder.mockResolvedValue({ ...baseWO, status: 'PENDING' });

    const out = await node.execute(baseState);

    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(fetchNode.markCompleted).toHaveBeenCalledWith(baseWO);
    expect(out.submitted).toBe(true);
    expect(out.completedWorkOrderIds).toContain('wo-1');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping stale result for WO wo-1 (status=PENDING)'),
    );
  });

  /**
   * Bug — cyclic re-offer dropped valid RESEARCH submissions.
   *
   * While a research round is OPEN the coordinator re-offers the round's WOs
   * round-robin and flips them back to PENDING while a node is still working
   * them. The coordinator ACCEPTS a research submit for a PENDING WO when the
   * round is OPEN (WorkOrderSubmissionService.ts, the OPEN-round RESEARCH
   * branch ~L372-374), so the node must
   * NOT drop a re-offered PENDING research WO locally — it must POST and let
   * the server's round-OPEN check decide. Terminal states (COMPLETED /
   * VERIFIED / CANCELLED) are still dropped.
   */
  describe('RESEARCH cyclic re-offer — PENDING is submittable', () => {
    // RESEARCH WOs hit the client-side quality gate (validateResearchResultJsonString)
    // BEFORE the stale probe; stub the execution helper to report RESEARCH and
    // supply a payload that passes the gate (hypothesis >= 30 chars, no error markers).
    const researchWO: WorkOrder = { ...baseWO, type: 'RESEARCH' };
    const researchResultJson = JSON.stringify({
      hypothesis: 'Distributed gradient averaging converges under heterogeneous batch sizes.',
      keyInsights: ['loss decreased monotonically across all peers'],
    });
    const researchState = {
      ...baseState,
      selectedWorkOrder: researchWO,
      executionResult: { success: true, result: researchResultJson },
    } as any;

    it('does NOT drop a PENDING research WO — proceeds to completeWorkOrder', async () => {
      coordinator.getWorkOrder.mockResolvedValue({ ...researchWO, status: 'PENDING' });
      coordinator.completeWorkOrder.mockResolvedValue(true);

      const out = await node.execute(researchState);

      expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
      expect(out.submitted).toBe(true);
      const droppedLog = infoSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('dropping stale result'));
      expect(droppedLog).toBeUndefined();
    });

    it('still drops a COMPLETED research WO (terminal state)', async () => {
      coordinator.getWorkOrder.mockResolvedValue({ ...researchWO, status: 'COMPLETED' });

      const out = await node.execute(researchState);

      expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
      expect(out.submitted).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('dropping stale result for WO wo-1 (status=COMPLETED)'),
      );
    });

    it('still drops a CANCELLED research WO (terminal state)', async () => {
      coordinator.getWorkOrder.mockResolvedValue({ ...researchWO, status: 'CANCELLED' });

      const out = await node.execute(researchState);

      expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
      expect(out.submitted).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('dropping stale result for WO wo-1 (status=CANCELLED)'),
      );
    });
  });

  /**
   * Bug 34 (2026-05-18) — post-submission log must NOT print
   * `Potential reward: ${rewardAmount} SYN`. That field is the round
   * POOL (e.g. 6000), not the per-peer payout (top-3 split 60/25/15:
   * 3600/1500/900/0 SYN). The misleading log was creating false
   * expectations on the pod. New form keeps id/type/iteration/submitted
   * and drops the SYN amount entirely.
   */
  describe('Bug 34 — post-submission log omits SYN amount', () => {
    it('on success: logs honest WO complete line without any SYN amount', async () => {
      coordinator.getWorkOrder.mockResolvedValue({ ...baseWO, status: 'ACCEPTED' });
      coordinator.completeWorkOrder.mockResolvedValue(true);

      await node.execute(baseState);

      const submittedLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('[WO complete]'));
      expect(submittedLog).toBeDefined();
      expect(submittedLog!).toContain('submitted=true');
      expect(submittedLog!).toContain('type=DILOCO_TRAINING');
      expect(submittedLog!).toContain('iter=3');
      expect(submittedLog!).toContain('id=wo-1');
      // The old misleading content must not appear.
      expect(submittedLog!).not.toMatch(/SYN/);
      expect(submittedLog!).not.toMatch(/Potential reward/);
      expect(submittedLog!).not.toMatch(/\d+(?:\.\d+)?\s*SYN/);
      // Sanity: no log call anywhere on the success path leaks the
      // rewardAmount template literal.
      const anySynLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => /SYN/.test(m));
      expect(anySynLog).toBeUndefined();
    });

    it('on failure (completeWorkOrder returns false): logs honest line with submitted=false', async () => {
      coordinator.getWorkOrder.mockResolvedValue({ ...baseWO, status: 'ACCEPTED' });
      coordinator.completeWorkOrder.mockResolvedValue(false);

      await node.execute(baseState);

      const failureLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('[WO complete]') && m.includes('submitted=false'));
      expect(failureLog).toBeDefined();
      expect(failureLog!).toContain('type=DILOCO_TRAINING');
      expect(failureLog!).toContain('iter=3');
      expect(failureLog!).not.toMatch(/SYN/);
    });

    it('falls back to type=UNKNOWN when WO has no type field', async () => {
      const woNoType = { ...baseWO };
      delete (woNoType as Partial<WorkOrder>).type;
      coordinator.getWorkOrder.mockResolvedValue({ ...woNoType, status: 'ACCEPTED' });
      coordinator.completeWorkOrder.mockResolvedValue(true);

      await node.execute({ ...baseState, selectedWorkOrder: woNoType });

      const submittedLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('[WO complete]'));
      expect(submittedLog).toBeDefined();
      expect(submittedLog!).toContain('type=UNKNOWN');
      expect(submittedLog!).toContain('submitted=true');
    });
  });
});
