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

  const baseWO: WorkOrder = {
    id: 'wo-1',
    title: 't',
    description: 'd',
    requiredCapabilities: ['cpu_inference'],
    rewardAmount: '1',
    status: 'ACCEPTED',
    creatorAddress: 'creator',
    createdAt: 0,
  };

  const baseState = {
    selectedWorkOrder: baseWO,
    executionResult: { success: true, result: 'ok' },
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    completedWorkOrderIds: [],
  } as any;

  beforeEach(() => {
    coordinator = {
      getWorkOrder: jest.fn(),
      completeWorkOrder: jest.fn(),
    };
    fetchNode = { markCompleted: jest.fn() };
    node = new SubmitResultNode(coordinator as any, fetchNode as any);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
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
});
