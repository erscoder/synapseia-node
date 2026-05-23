/**
 * Bug 20 v4 (2026-05-23) — SubmitResultNode reports failures to the
 * coordinator instead of silently abandoning them (P21/P22).
 *
 * Before this change, a failed execution (e.g. a docking gen3d timeout)
 * only armed the local cooldown via `markCompleted` and returned — the WO
 * stayed ACCEPTED on the coord until the ACCEPTED-TTL reaper ran, blocking
 * re-dispatch for minutes. Now the node POSTs `success: false` to the same
 * `/work-orders/:id/complete` endpoint the success path uses, so the coord
 * releases the WO promptly. The LIGHT backpressure slot is released
 * independently by AgentGraphService after this node returns.
 *
 * Contract verified here:
 *   1. A failed docking timeout → completeWorkOrder called with success=false.
 *   2. The per-WO timeout counter still increments (Bug 20 v3 preserved).
 *   3. markCompleted (cooldown) still arms.
 *   4. A failed report (network error → returns false) is logged clearly,
 *      not silently dropped.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SubmitResultNode } from '../submit-result';
import logger from '../../../../../utils/logger';
import type { WorkOrder } from '../../../work-order/work-order.types';

describe('SubmitResultNode — failed execution reports to coordinator (Bug 20 v4)', () => {
  let coordinator: { getWorkOrder: jest.Mock; completeWorkOrder: jest.Mock };
  let fetchNode: { markCompleted: jest.Mock; markFailedTimeout: jest.Mock };
  let execution: { isResearchWorkOrder: jest.Mock; isDockingWorkOrder: jest.Mock };
  let node: SubmitResultNode;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;

  const dockingWO: WorkOrder = {
    id: 'wo-docking-1',
    title: 'dock',
    description: '{}',
    requiredCapabilities: ['docking'],
    rewardAmount: '6000',
    status: 'ACCEPTED',
    creatorAddress: 'creator',
    createdAt: 0,
    type: 'MOLECULAR_DOCKING',
  };

  const failState = {
    selectedWorkOrder: dockingWO,
    executionResult: {
      success: false,
      result: 'Docking failed [ligand] Process timed out after 90000ms: obabel ligand.smi -O ligand.pdbqt --gen3d fast -h',
    },
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    walletAddress: 'wallet-1',
    completedWorkOrderIds: [],
    iteration: 2,
  } as any;

  beforeEach(() => {
    coordinator = {
      getWorkOrder: jest.fn(),
      completeWorkOrder: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    };
    fetchNode = { markCompleted: jest.fn(), markFailedTimeout: jest.fn() };
    execution = {
      isResearchWorkOrder: jest.fn().mockReturnValue(false),
      isDockingWorkOrder: jest.fn().mockReturnValue(true),
    };
    node = new SubmitResultNode(coordinator as any, fetchNode as any, execution as any);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('POSTs success=false to the coordinator on a failed docking timeout', async () => {
    const out = await node.execute(failState);

    expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
    const args = coordinator.completeWorkOrder.mock.calls[0]!;
    // Positional contract: (url, id, peerId, wallet, result, success, ...)
    expect(args[1]).toBe('wo-docking-1');
    expect(args[5]).toBe(false); // success flag === false
    // No probe needed for the failure report — it goes straight to /complete.
    expect(out.submitted).toBe(false);
  });

  it('still increments the per-WO timeout counter (Bug 20 v3 preserved)', async () => {
    await node.execute(failState);
    expect(fetchNode.markFailedTimeout).toHaveBeenCalledWith(
      'wo-docking-1',
      'obabel-gen3d-timeout',
    );
  });

  it('still arms the local cooldown via markCompleted', async () => {
    await node.execute(failState);
    expect(fetchNode.markCompleted).toHaveBeenCalledWith(dockingWO);
  });

  it('logs the prompt-release info line when the coord acks the failure', async () => {
    coordinator.completeWorkOrder.mockResolvedValue(true);
    await node.execute(failState);
    const released = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('reported failure for WO wo-docking-1'));
    expect(released).toBeDefined();
    expect(released!).toContain('released for re-dispatch');
  });

  it('does NOT silently drop a failed report — logs the reaper-fallback warning (P22)', async () => {
    coordinator.completeWorkOrder.mockResolvedValue(false); // network error / non-400 reject
    await node.execute(failState);
    const fallback = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('failure report for WO wo-docking-1 not acked'));
    expect(fallback).toBeDefined();
    expect(fallback!).toContain('ACCEPTED-TTL reaper');
    // Cooldown still armed even when the report failed.
    expect(fetchNode.markCompleted).toHaveBeenCalledWith(dockingWO);
  });

  it('non-docking failure also reports to coord (no silent abandon)', async () => {
    execution.isDockingWorkOrder.mockReturnValue(false);
    const researchFail = {
      ...failState,
      selectedWorkOrder: { ...dockingWO, type: 'RESEARCH', id: 'wo-research-1' },
      executionResult: { success: false, result: 'synth error' },
    };
    await node.execute(researchFail);
    expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
    expect(coordinator.completeWorkOrder.mock.calls[0]![5]).toBe(false);
    // Non-docking failure does not increment the docking timeout counter.
    expect(fetchNode.markFailedTimeout).not.toHaveBeenCalled();
  });
});
