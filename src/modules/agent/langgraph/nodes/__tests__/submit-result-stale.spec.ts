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
    fetchNode = { markCompleted: jest.fn() };
    node = new SubmitResultNode(coordinator as any, fetchNode as any);
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
