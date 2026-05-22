/**
 * lora_trainer-envelope.spec.ts — Slice 8 (2026-05-17).
 *
 * Covers the Ollama pause + heavy-training-preflight envelope wrapping
 * the LoRA python spawn (mirrors the Bug 27/Bug 28 envelope already
 * wired into DiLoCo):
 *
 *   1. happy path — pause → preflight pass → spawn → restart in finally.
 *   2. InsufficientMemoryError — pause → preflight throws → restart
 *      STILL fires (finally invariant). Error bubbles unchanged.
 *   3. executeLoraWorkOrder catches InsufficientMemoryError and returns
 *      `{ success: false, result: 'LoRA skipped: ...' }` without
 *      re-queuing client-side (reviewer-lesson P21).
 *
 * Reviewer-lesson alignment: P21 (no client-side re-queue, coord TTL
 * handles re-route), P24 (preflight fail-CLOSED stays fail-CLOSED here
 * — the mock that throws is the contract the caller agrees to),
 * P29 (mocks assert numeric error fields, not just "didn't throw").
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Set up envelope mocks BEFORE importing lora_trainer so the imports
// bind to the mock factory results.
const mockPause = jest.fn();
const mockRestart = jest.fn();
const mockEnsureMem = jest.fn();

jest.mock('../../llm/ollama-pause', () => ({
  maybePauseOllamaForHeavyTraining: (...args: unknown[]) => mockPause(...args),
  maybeRestartOllamaAfterHeavyTraining: (...args: unknown[]) => mockRestart(...args),
}));

jest.mock('../../model/heavy-training-preflight', () => ({
  ensureMemForHeavyTraining: (...args: unknown[]) => mockEnsureMem(...args),
  // Slice 17: caller now selects the threshold via the dynamic helper.
  // Mock returns LORA_REQUIRED_FREE_MB so existing assertions on the
  // numeric value keep working without touching the probe path.
  requiredMemForHeavyTraining: (workload: 'DiLoCo' | 'LoRA') =>
    workload === 'DiLoCo' ? 18432 : 14336,
  detectQuantSupport: () => false,
  __resetQuantSupportCacheForTests: () => undefined,
  DILOCO_REQUIRED_FREE_MB: 18432,
  DILOCO_REQUIRED_FREE_MB_FP32: 18432,
  DILOCO_REQUIRED_FREE_MB_QUANT: 8192,
  LORA_REQUIRED_FREE_MB: 14336,
  LORA_REQUIRED_FREE_MB_FP32: 14336,
  LORA_REQUIRED_FREE_MB_QUANT: 6144,
  InsufficientMemoryError: class InsufficientMemoryError extends Error {
    constructor(msg: string, public readonly freeMB: number, public readonly requiredMB: number) {
      super(msg);
      this.name = 'InsufficientMemoryError';
    }
  },
}));

import { runLora, LoraError } from '../lora_trainer';
import { LORA_REQUIRED_FREE_MB, InsufficientMemoryError } from '../../model/heavy-training-preflight';
import type { LoraWorkOrderPayload } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function payload(overrides: Partial<LoraWorkOrderPayload> = {}): LoraWorkOrderPayload {
  return {
    adapterId: 'lora_mission_x_pubmedbert_v1',
    missionId: 'mission_x',
    subtype: 'LORA_CLASSIFICATION',
    baseModel: 'PubMedBERT',
    trainingDatasetUri: 'https://example.com/train.jsonl',
    validationDatasetUri: 'https://example.com/val.jsonl',
    loraConfig: { r: 8, alpha: 16, dropout: 0.1, target_modules: ['q_proj'] },
    maxEpochs: 1,
    earlyStopPatience: 0,
    seed: 42,
    uploadUrl: 'https://s3.example.com/upload?signed=1',
    ...overrides,
  };
}

describe('runLora envelope — Slice 8 OOM mitigation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lora-env-test-'));
    mockPause.mockReset();
    mockRestart.mockReset();
    mockEnsureMem.mockReset();
    // Sensible defaults — each test overrides as needed.
    mockPause.mockResolvedValue({ wasRunning: false, pausedAt: 0 });
    mockRestart.mockResolvedValue(undefined);
    mockEnsureMem.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('happy path — pause → preflight pass → spawn → restart in finally (correct order)', async () => {
    // Capture call order across the three envelope helpers so the test
    // proves the pause happens BEFORE preflight (kernel needs to reclaim
    // Ollama RSS before the re-probe), and restart happens AFTER spawn
    // (regardless of success).
    const callOrder: string[] = [];
    mockPause.mockImplementation(async () => {
      callOrder.push('pause');
      return { wasRunning: true, pausedAt: 1000 };
    });
    mockEnsureMem.mockImplementation(async (requiredMB: unknown) => {
      callOrder.push(`ensureMem:${requiredMB}`);
    });
    mockRestart.mockImplementation(async () => {
      callOrder.push('restart');
    });

    // A trivial python script that writes the expected outputs and exits
    // 0 — same pattern as the integration spec.
    const scriptPath = path.join(tmpDir, 'fake_train.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys, json, os',
      'data = json.loads(sys.stdin.read())',
      'out = data["outDir"]',
      'os.makedirs(out, exist_ok=True)',
      'open(os.path.join(out, "adapter_model.safetensors"), "wb").write(b"x")',
      'open(os.path.join(out, "metrics.json"), "w").write(\'{"accuracy":0.9}\')',
    ].join('\n'), 'utf8');

    const uploader = jest.fn(async () => undefined);

    const submission = await runLora(
      { workOrderId: 'wo_lora_env_1', peerId: 'peer1', payload: payload() },
      { scriptPath, workDir: tmpDir, uploader },
    );

    // Envelope invariants
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(mockEnsureMem).toHaveBeenCalledTimes(1);
    expect(mockEnsureMem).toHaveBeenCalledWith(LORA_REQUIRED_FREE_MB, { label: 'LoRA' });
    expect(mockRestart).toHaveBeenCalledTimes(1);
    // Restart receives the pause handle so the no-op short-circuit
    // works when wasRunning=false.
    expect(mockRestart).toHaveBeenCalledWith({ wasRunning: true, pausedAt: 1000 });

    // Order: pause < ensureMem < restart. We don't pin "spawn" inside
    // this list because the python subprocess runs out-of-band; but
    // restart MUST be last (finally) and ensureMem MUST be after pause.
    expect(callOrder[0]).toBe('pause');
    expect(callOrder[1]).toBe(`ensureMem:${LORA_REQUIRED_FREE_MB}`);
    expect(callOrder[callOrder.length - 1]).toBe('restart');

    // Submission shape sanity — proves spawn actually ran inside the envelope.
    expect(submission.adapterId).toBe('lora_mission_x_pubmedbert_v1');
    expect(submission.reportedValMetrics).toEqual({ accuracy: 0.9 });
    expect(uploader).toHaveBeenCalledTimes(1);
  });

  it('InsufficientMemoryError — preflight throws, restart STILL fires (finally invariant), error bubbles', async () => {
    mockPause.mockResolvedValue({ wasRunning: true, pausedAt: 2000 });
    const memErr = new InsufficientMemoryError(
      `LoRA needs ${LORA_REQUIRED_FREE_MB}MB free after liberation, only 8000MB available (was 7000MB before)`,
      8000,
      LORA_REQUIRED_FREE_MB,
    );
    mockEnsureMem.mockRejectedValue(memErr);

    // assertFileExists runs BEFORE the envelope opens, so we need a
    // real script on disk to ensure the preflight is what trips.
    const scriptPath = path.join(tmpDir, 'wont-be-spawned.py');
    await fs.promises.writeFile(scriptPath, '#!/usr/bin/env python3\npass\n', 'utf8');

    let caught: unknown = null;
    try {
      await runLora(
        { workOrderId: 'wo_lora_oom', peerId: 'peer1', payload: payload() },
        { scriptPath, workDir: tmpDir },
      );
    } catch (err) {
      caught = err;
    }

    // The error bubbles unchanged.
    expect(caught).toBeInstanceOf(InsufficientMemoryError);
    expect((caught as InsufficientMemoryError).freeMB).toBe(8000);
    expect((caught as InsufficientMemoryError).requiredMB).toBe(LORA_REQUIRED_FREE_MB);
    expect((caught as InsufficientMemoryError).message).toContain('LoRA');

    // Restart still fired in finally — the daemon does NOT leak in the
    // paused state when preflight fails. This is the critical invariant.
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(mockEnsureMem).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledWith({ wasRunning: true, pausedAt: 2000 });
  });

  it('InsufficientMemoryError — proves python spawn never happened (no adapter file written)', async () => {
    // Belt and braces: use a script that WOULD write the adapter if
    // spawned, then assert the file does not exist after the call.
    // If the envelope accidentally bypassed the preflight throw and
    // proceeded to spawn, the adapter file would be present.
    mockPause.mockResolvedValue({ wasRunning: true, pausedAt: 3000 });
    mockEnsureMem.mockRejectedValue(
      new InsufficientMemoryError(
        `LoRA needs ${LORA_REQUIRED_FREE_MB}MB free, only 100MB`,
        100,
        LORA_REQUIRED_FREE_MB,
      ),
    );

    const scriptPath = path.join(tmpDir, 'would-write-adapter.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys, json, os',
      'data = json.loads(sys.stdin.read())',
      'out = data["outDir"]',
      'os.makedirs(out, exist_ok=True)',
      'open(os.path.join(out, "adapter_model.safetensors"), "wb").write(b"x")',
      'open(os.path.join(out, "metrics.json"), "w").write(\'{"a":1}\')',
    ].join('\n'), 'utf8');

    await expect(runLora(
      { workOrderId: 'wo_lora_oom2', peerId: 'peer1', payload: payload() },
      { scriptPath, workDir: tmpDir },
    )).rejects.toBeInstanceOf(InsufficientMemoryError);

    // Adapter file MUST NOT exist — spawn never ran.
    await expect(
      fs.promises.access(path.join(tmpDir, 'adapter_model.safetensors')),
    ).rejects.toThrow();
  });

  it('LoraError from spawn still triggers restart in finally', async () => {
    // A non-preflight error (e.g. python crash) must also fire restart.
    // Same invariant as the InsufficientMemoryError test but exercises
    // the "spawn ran and failed" branch instead of the "preflight tripped"
    // branch.
    mockPause.mockResolvedValue({ wasRunning: true, pausedAt: 4000 });

    const scriptPath = path.join(tmpDir, 'fail_train.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys',
      'sys.stderr.write("kaboom")',
      'sys.exit(13)',
    ].join('\n'), 'utf8');

    await expect(runLora(
      { workOrderId: 'wo_lora_crash', peerId: 'peer1', payload: payload() },
      { scriptPath, workDir: tmpDir },
    )).rejects.toBeInstanceOf(LoraError);

    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(mockEnsureMem).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledWith({ wasRunning: true, pausedAt: 4000 });
  });
});

/**
 * executeLoraWorkOrder bubble-up test — proves the LangGraph WO handler
 * converts InsufficientMemoryError into a controlled
 * `{ success: false }` response so the coord ACCEPTED-TTL expiry handles
 * re-routing (reviewer-lesson P21: no client-side re-queue).
 *
 * Mocks `runLora` directly via the module under test so we exercise
 * exactly the executeLoraWorkOrder catch branch without spinning up the
 * full execution helper graph.
 */
describe('executeLoraWorkOrder — InsufficientMemoryError bubble-up', () => {
  it('catches InsufficientMemoryError → returns { success: false, result: starts with "LoRA skipped:" }', async () => {
    // Use require here to avoid hoisting weirdness with the envelope
    // mocks above — we want the REAL executeLoraWorkOrder against a
    // mocked runLora.
    jest.isolateModules(() => {
      const memErr = new InsufficientMemoryError(
        'LoRA needs 14336MB free after liberation, only 8000MB available (was 7000MB before)',
        8000,
        14336,
      );

      jest.doMock('../lora_trainer', () => ({
        runLora: jest.fn(async () => { throw memErr; }),
        LoraError: class LoraError extends Error {
          constructor(msg: string, public readonly stage: string) {
            super(msg);
            this.name = 'LoraError';
          }
        },
      }));
      jest.doMock('../../model/heavy-training-preflight', () => ({
        InsufficientMemoryError,
        DILOCO_REQUIRED_FREE_MB: 18432,
        LORA_REQUIRED_FREE_MB: 14336,
      }));

      // The execution module pulls in many deps via WorkOrderExecutionHelper;
      // we only need executeLoraWorkOrder so we exercise the method in
      // isolation. Instantiate the helper with minimal stubs.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WorkOrderExecutionHelper } = require('../../agent/work-order/work-order.execution');

      const helper = new WorkOrderExecutionHelper(
        {} as never, // coordinator
        {} as never, // evaluation
        {} as never, // llmProvider
      );

      const wo = {
        id: 'wo_oom',
        title: 'LoRA training x',
        type: 'LORA_TRAINING',
        description: JSON.stringify({
          adapterId: 'lora_a',
          missionId: 'm',
          subtype: 'LORA_CLASSIFICATION',
          baseModel: 'PubMedBERT',
          trainingDatasetUri: 'u',
          validationDatasetUri: 'u',
          loraConfig: { r: 8, alpha: 16, dropout: 0.1, target_modules: [] },
          maxEpochs: 1,
          earlyStopPatience: 0,
          seed: 1,
          uploadUrl: 'https://s3/upload?x=1',
        }),
      };

      // The method is async — return the promise to Jest via expect().
      return helper.executeLoraWorkOrder(wo, 'peer1').then((res: { result: string; success: boolean }) => {
        expect(res.success).toBe(false);
        expect(res.result).toMatch(/^LoRA skipped:/);
        // Per P21: result must NOT mention re-queue / retry semantics.
        // The coord handles re-routing via ACCEPTED-TTL expiry.
        expect(res.result.toLowerCase()).not.toContain('requeue');
        expect(res.result.toLowerCase()).not.toContain('retry');
      });
    });
  });
});
