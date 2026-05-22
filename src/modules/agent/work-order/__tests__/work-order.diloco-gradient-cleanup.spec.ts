/**
 * Disk-leak regression (2026-05-22): the DiLoCo gradient upload flow must
 * delete the on-disk temp gradient file (`*_diloco_gradients.pt`, written by
 * scripts/diloco_train.py with `delete=False`) after the Node side reads it
 * into a buffer and uploads it. Before the fix each outer round orphaned one
 * ~89 MB file in /tmp and filled GPU pods to 89% disk.
 *
 * Contract under test (work-order.execution.ts executeDiLoCoWorkOrder):
 *  - temp file deleted after a SUCCESSFUL upload,
 *  - temp file deleted after a FAILED upload (rm runs in `finally`),
 *  - deletion targets the WO's exact path only — never a glob/wildcard.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';

// runDiLoCoInnerLoop is a heavy python spawn — stub it to return a fixed
// gradientPath so the spec is fast and host-agnostic. The path is the seam
// the cleanup code must rm.
const GRADIENT_PATH = '/tmp/tmpABC123_diloco_gradients.pt';
jest.mock('../../../model/diloco-trainer', () => ({
  runDiLoCoInnerLoop: jest.fn(async () => ({
    finalLoss: 1.2,
    valLoss: 1.26,
    innerSteps: 4,
    durationMs: 1000,
    gradientPath: GRADIENT_PATH,
    gradientSizeBytes: 89_000_000,
  })),
}));

// Hardware probe / runtime-mode are environment-dependent; pin them so the
// spec runs identically on CPU CI and GPU pods.
jest.mock('../../../hardware/hardware', () => ({
  detectHardware: jest.fn(() => ({ gpuVramGb: 0 })),
}));
jest.mock('../../../hardware/runtime-mode', () => ({
  deriveTrainingRuntimeMode: jest.fn(() => 'cpu'),
}));

import { WorkOrderExecutionHelper } from '../work-order.execution';
import type { WorkOrderCoordinatorHelper } from '../work-order.coordinator';
import type { WorkOrderEvaluationHelper } from '../work-order.evaluation';
import type { LlmProviderHelper } from '../../../llm/llm-provider';
import type { WorkOrder } from '../work-order.types';

function makeDiLoCoWorkOrder(): WorkOrder {
  const description = JSON.stringify({
    domain: 'math',
    modelId: 'Qwen/Qwen2.5-0.5B',
    outerRound: 1,
    innerSteps: 4,
    deadline: Date.now() + 60_000,
    hyperparams: { learningRate: 0.0002 },
    // no currentAdapterUrl → skips the adapter download branch.
  });
  return { id: 'wo-diloco-1', title: 'DiLoCo round 1', type: 'DILOCO_TRAINING', description, requiredCapabilities: [] } as unknown as WorkOrder;
}

describe('executeDiLoCoWorkOrder — temp gradient file cleanup', () => {
  let helper: WorkOrderExecutionHelper;
  let uploadGradients: jest.MockedFunction<WorkOrderCoordinatorHelper['uploadGradients']>;
  let readFileSpy: jest.SpiedFunction<typeof fs.promises.readFile>;
  let rmSpy: jest.SpiedFunction<typeof fs.promises.rm>;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    uploadGradients = jest.fn() as jest.MockedFunction<WorkOrderCoordinatorHelper['uploadGradients']>;
    const coordinator = {
      uploadGradients,
      // dataset download is best-effort (caught) — reject to skip it cleanly.
      downloadDataset: jest.fn(async () => { throw new Error('no dataset'); }),
    } as unknown as WorkOrderCoordinatorHelper;
    helper = new WorkOrderExecutionHelper(
      coordinator,
      {} as unknown as WorkOrderEvaluationHelper,
      {} as unknown as LlmProviderHelper,
    );

    // The execution code does `import('fs')` then reads the gradient buffer
    // and rm's the path. Spy on both so no real disk I/O happens.
    readFileSpy = jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('grad-bytes'));
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('deletes the temp gradient file after a SUCCESSFUL upload', async () => {
    uploadGradients.mockResolvedValue(true);

    const res = await helper.executeDiLoCoWorkOrder(makeDiLoCoWorkOrder(), 'http://coord', 'peer-1', []);

    expect(res.success).toBe(true);
    expect(readFileSpy).toHaveBeenCalledWith(GRADIENT_PATH);
    expect(uploadGradients).toHaveBeenCalledTimes(1);
    expect(rmSpy).toHaveBeenCalledTimes(1);
    // Deletes the WO's exact path with force, never a glob/wildcard.
    expect(rmSpy).toHaveBeenCalledWith(GRADIENT_PATH, { force: true });
  });

  it('deletes the temp gradient file after a FAILED upload (rm runs in finally)', async () => {
    uploadGradients.mockRejectedValue(new Error('coord 503 upload failed'));

    // The WO still succeeds — upload failure is a warn-level recoverable path;
    // the cleanup must still run.
    const res = await helper.executeDiLoCoWorkOrder(makeDiLoCoWorkOrder(), 'http://coord', 'peer-1', []);

    expect(res.success).toBe(true);
    expect(uploadGradients).toHaveBeenCalledTimes(1);
    expect(rmSpy).toHaveBeenCalledTimes(1);
    expect(rmSpy).toHaveBeenCalledWith(GRADIENT_PATH, { force: true });
  });

  it('does not glob/wildcard-delete; only the WO\'s own exact path', async () => {
    uploadGradients.mockResolvedValue(true);

    await helper.executeDiLoCoWorkOrder(makeDiLoCoWorkOrder(), 'http://coord', 'peer-1', []);

    const rmTargets = rmSpy.mock.calls.map(c => String(c[0]));
    expect(rmTargets).toEqual([GRADIENT_PATH]);
    // No wildcard / brace / directory-glob target ever passed to rm.
    for (const t of rmTargets) {
      expect(t).not.toMatch(/[*?{}]/);
    }
  });
});
