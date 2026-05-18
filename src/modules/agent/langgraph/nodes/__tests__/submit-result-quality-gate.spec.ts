/**
 * Bug 31 (2026-05-18) — SubmitResultNode client-side research quality gate.
 *
 * Mirrors coord's hypothesis_too_short reject (>=30 chars) locally so the
 * pod skips the POST entirely when execution produced a malformed payload.
 * The synthesizer-node empty-summary fix is the primary defense; this gate
 * is belt-and-suspenders (P26 reviewer-lesson — multiple validators on the
 * same untrusted input).
 *
 * Bug 20 v3 (2026-05-18) — also covers the docking timeout failure
 * counter increment path on execution-failed docking WOs.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SubmitResultNode } from '../submit-result';
import logger from '../../../../../utils/logger';

describe('SubmitResultNode — Bug 31 local quality gate', () => {
  let coordinator: any;
  let fetchNode: any;
  let execution: any;
  let node: SubmitResultNode;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;

  const researchWO = {
    id: 'wo-r-1', title: 'R', description: '', requiredCapabilities: [],
    rewardAmount: '1', status: 'ACCEPTED', creatorAddress: 'c', createdAt: 0,
    type: 'RESEARCH',
  } as any;

  const dockingWO = {
    id: 'wo-d-1', title: 'D', description: '', requiredCapabilities: [],
    rewardAmount: '1', status: 'ACCEPTED', creatorAddress: 'c', createdAt: 0,
    type: 'MOLECULAR_DOCKING',
  } as any;

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
    execution = {
      isResearchWorkOrder: jest.fn((wo: any) => wo?.type === 'RESEARCH'),
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

  it('rejects research WO with bare-`{` summary locally (no POST to coord)', async () => {
    const state = {
      ...baseState,
      selectedWorkOrder: researchWO,
      executionResult: {
        success: true,
        result: JSON.stringify({ summary: '{', keyInsights: [], proposal: '' }),
      },
    };
    const out = await node.execute(state);
    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(fetchNode.markCompleted).toHaveBeenCalledWith(researchWO);
    expect(out.submitted).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Local quality gate rejected'),
    );
  });

  it('rejects research WO with placeholder summary locally', async () => {
    const state = {
      ...baseState,
      selectedWorkOrder: researchWO,
      executionResult: {
        success: true,
        result: JSON.stringify({
          summary: 'No summary generated',
          keyInsights: [],
          proposal: 'No proposal generated',
        }),
      },
    };
    const out = await node.execute(state);
    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(out.submitted).toBe(false);
  });

  it('admits research WO that passes the local gate', async () => {
    const goodSummary =
      'Riluzole at 50mg twice daily extends median ALS survival by approximately three months versus placebo across replications.';
    const state = {
      ...baseState,
      selectedWorkOrder: researchWO,
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

  // Non-RESEARCH WOs bypass the gate — their shape doesn't match
  // {summary, proposal, keyInsights} and they're validated by domain
  // services on the coord (DockingSubmissionService, LoRA, etc.).
  it('does NOT apply the gate to non-research WOs (docking)', async () => {
    const state = {
      ...baseState,
      selectedWorkOrder: dockingWO,
      executionResult: {
        success: true,
        result: JSON.stringify({ workOrderId: 'x', bestAffinity: -7.5, poses: [] }),
      },
    };
    const out = await node.execute(state);
    expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
    expect(out.submitted).toBe(true);
  });

  it('Bug 20 v3 — increments timeout counter on docking timeout failure', async () => {
    const state = {
      ...baseState,
      selectedWorkOrder: dockingWO,
      executionResult: {
        success: false,
        result: 'Docking failed [ligand] Process timed out after 300000ms: obabel ... --gen3d med',
      },
    };
    const out = await node.execute(state);
    expect(fetchNode.markFailedTimeout).toHaveBeenCalledWith(
      dockingWO.id,
      'obabel-gen3d-timeout',
    );
    expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
    expect(out.submitted).toBe(false);
  });

  it('Bug 20 v3 — does NOT increment timeout counter on non-timeout docking failure', async () => {
    const state = {
      ...baseState,
      selectedWorkOrder: dockingWO,
      executionResult: {
        success: false,
        result: 'Docking failed [vina] exited with code 1: bad-receptor.pdbqt',
      },
    };
    await node.execute(state);
    expect(fetchNode.markFailedTimeout).not.toHaveBeenCalled();
  });

  it('Bug 20 v3 — does NOT increment timeout counter on research WO failure', async () => {
    const state = {
      ...baseState,
      selectedWorkOrder: researchWO,
      executionResult: {
        success: false,
        result: 'schema_invalid_after_retries: some error',
      },
    };
    await node.execute(state);
    expect(fetchNode.markFailedTimeout).not.toHaveBeenCalled();
  });
});
