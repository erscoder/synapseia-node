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
    delete process.env.SYN_FORCE_GPU;
    delete process.env.SYN_FORCE_NO_GPU;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses LORA_GENERATION on a CPU-only node (loud failure)', async () => {
    process.env.SYN_FORCE_NO_GPU = 'true';
    await expect(runLora({
      workOrderId: 'wo1', peerId: 'peer1',
      payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large' }),
    })).rejects.toThrow(LoraError);
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
