// Slice 8 (2026-05-17): runLora now wraps the python spawn in an Ollama
// pause + preflight memory gate envelope (see
// modules/model/heavy-training-preflight.ts). Stub both so this
// integration spec (which actually spawns python) stays focused on the
// orchestration semantics it was originally written for and doesn't
// trip the cgroup-free-mem gate on CI runners with <14 GB free.
jest.mock('../../llm/ollama-pause', () => ({
  maybePauseOllamaForHeavyTraining: jest.fn(async () => ({ wasRunning: false, pausedAt: 0 })),
  maybeRestartOllamaAfterHeavyTraining: jest.fn(async () => undefined),
}));
jest.mock('../../model/heavy-training-preflight', () => ({
  ensureMemForHeavyTraining: jest.fn(async () => undefined),
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
// CUDA detection now lives in the shared helper. Mock it so the GENERATION
// precheck never spawns a real python `import torch` probe on CI.
const mockDetectCuda = jest.fn(async () => false);
jest.mock('../../../utils/gpu-detect', () => ({
  detectCudaAvailable: () => mockDetectCuda(),
}));

// `os.platform`/`os.arch` are non-configurable native props, so spyOn fails.
// Mock the module: keep everything real, but make platform/arch controllable
// so we can drive the darwin-MPS vs Linux-CUDA branches of hasGpu().
const realOs = jest.requireActual<typeof import('os')>('os');
const mockPlatform = jest.fn(() => realOs.platform());
const mockArch = jest.fn(() => realOs.arch());
jest.mock('os', () => ({
  ...jest.requireActual<typeof import('os')>('os'),
  platform: () => mockPlatform(),
  arch: () => mockArch(),
}));

import { runLora, LoraError } from '../lora_trainer';
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

describe('runLora — preflight + orchestration (mocked)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lora-test-'));
    mockDetectCuda.mockReset();
    mockDetectCuda.mockResolvedValue(false);
    mockPlatform.mockReset().mockReturnValue(realOs.platform());
    mockArch.mockReset().mockReturnValue(realOs.arch());
    delete process.env.SYN_FORCE_GPU;
    delete process.env.SYN_FORCE_NO_GPU;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses LORA_GENERATION when detectCudaAvailable() is false (loud failure)', async () => {
    mockDetectCuda.mockResolvedValue(false);
    await expect(runLora({
      workOrderId: 'wo1', peerId: 'peer1',
      payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large' }),
    })).rejects.toThrow(LoraError);
    await expect(runLora({
      workOrderId: 'wo1', peerId: 'peer1',
      payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large' }),
    })).rejects.toThrow(/requires a GPU/);
  });

  it('passes the LORA_GENERATION precheck when detectCudaAvailable() is true (Linux)', async () => {
    // Force the Linux/CUDA branch of hasGpu (the suite host may be macOS,
    // where the MPS rule short-circuits GENERATION before the probe).
    mockPlatform.mockReturnValue('linux');
    mockArch.mockReturnValue('x64');
    // CUDA available → precheck passes; then we control the rest of the
    // pipeline via a stub trainer script so the spawn succeeds end-to-end.
    mockDetectCuda.mockResolvedValue(true);
    const scriptPath = path.join(tmpDir, 'fake_train.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys, json, os',
      'data = json.loads(sys.stdin.read())',
      'out = data["outDir"]',
      'os.makedirs(out, exist_ok=True)',
      'open(os.path.join(out, "adapter_model.safetensors"), "wb").write(b"x")',
      'open(os.path.join(out, "metrics.json"), "w").write(\'{"perplexity":12.5}\')',
    ].join('\n'), 'utf8');

    const submission = await runLora(
      {
        workOrderId: 'wo_gen_1', peerId: 'peer1',
        payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large' }),
      },
      { scriptPath, workDir: tmpDir, uploader: async () => undefined },
    );
    expect(submission.adapterId).toBe('lora_mission_x_pubmedbert_v1');
    expect(mockDetectCuda).toHaveBeenCalled();
  });

  it('ignores SYN_FORCE_GPU / SYN_FORCE_NO_GPU env vars (no longer consulted)', async () => {
    // Operators never configured these — detection is purely the probe now.
    mockPlatform.mockReturnValue('linux');
    mockArch.mockReturnValue('x64');
    process.env.SYN_FORCE_GPU = 'true';   // would have forced a pass under old code
    process.env.SYN_FORCE_NO_GPU = 'true';
    mockDetectCuda.mockResolvedValue(false);
    await expect(runLora({
      workOrderId: 'wo_env', peerId: 'peer1',
      payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large' }),
    })).rejects.toThrow(/requires a GPU/);
  });

  it('refuses LORA_GENERATION on darwin/arm64 (MPS rule) without consulting torch.cuda', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockArch.mockReturnValue('arm64');
    mockDetectCuda.mockResolvedValue(true); // even if CUDA "true", MPS rule wins
    await expect(runLora({
      workOrderId: 'wo_mps', peerId: 'peer1',
      payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large' }),
    })).rejects.toThrow(/requires a GPU/);
    expect(mockDetectCuda).not.toHaveBeenCalled();
  });

  it('builds the submission payload from trainer outputs and uploads to S3', async () => {
    // Stub a "trainer" that just writes adapter + metrics into the workDir.
    // Pass workDir explicitly so the runner doesn't make a temp dir.
    const fakeAdapterBytes = Buffer.from('fake-adapter-bytes-not-real-safetensors');
    const fakeMetrics = { accuracy: 0.91, f1: 0.88 };

    const scriptPath = path.join(tmpDir, 'fake_train.py');
    // Bare-minimum python that reads stdin (the WO payload), writes the
    // adapter + metrics, then exits.
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys, json, os',
      'data = json.loads(sys.stdin.read())',
      'out = data["outDir"]',
      'os.makedirs(out, exist_ok=True)',
      `open(os.path.join(out, "adapter_model.safetensors"), "wb").write(b"${fakeAdapterBytes.toString()}")`,
      `open(os.path.join(out, "metrics.json"), "w").write(${JSON.stringify(JSON.stringify(fakeMetrics))})`,
    ].join('\n'), 'utf8');

    const uploads: Array<{ url: string; bytes: number }> = [];
    const uploader = async (url: string, file: string) => {
      const buf = await fs.promises.readFile(file);
      uploads.push({ url, bytes: buf.length });
    };

    const submission = await runLora(
      { workOrderId: 'wo_lora_1', peerId: 'peer1', payload: payload() },
      { scriptPath, workDir: tmpDir, uploader },
    );

    expect(submission.adapterId).toBe('lora_mission_x_pubmedbert_v1');
    expect(submission.reportedValMetrics).toEqual(fakeMetrics);
    expect(submission.artifactUri).toBe('https://s3.example.com/upload'); // query stripped
    expect(submission.artifactSha256).toMatch(/^sha256:/);
    expect(submission.trainerPeerId).toBe('peer1');
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe('https://s3.example.com/upload?signed=1');
    expect(uploads[0].bytes).toBe(fakeAdapterBytes.length);
  });

  it('fails when the trainer does not produce metrics.json', async () => {
    const scriptPath = path.join(tmpDir, 'broken_train.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys, json, os',
      'data = json.loads(sys.stdin.read())',
      'out = data["outDir"]',
      'os.makedirs(out, exist_ok=True)',
      'open(os.path.join(out, "adapter_model.safetensors"), "wb").write(b"x")',
    ].join('\n'), 'utf8');

    await expect(runLora(
      { workOrderId: 'wo1', peerId: 'p', payload: payload() },
      { scriptPath, workDir: tmpDir, uploader: async () => undefined },
    )).rejects.toThrow(/metrics\.json/);
  });

  it('fails when the trainer exits non-zero', async () => {
    const scriptPath = path.join(tmpDir, 'fail_train.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys',
      'sys.stderr.write("intentional failure")',
      'sys.exit(7)',
    ].join('\n'), 'utf8');

    await expect(runLora(
      { workOrderId: 'wo1', peerId: 'p', payload: payload() },
      { scriptPath, workDir: tmpDir, uploader: async () => undefined },
    )).rejects.toThrow(/exited with code 7/);
  });
});
