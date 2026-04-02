/**
 * Sprint E Tests Part 1 — DiLoCo Trainer (E2) + Hardware (E7)
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// ======================================================================
// E2: diloco-trainer
// ======================================================================
import {
  runDiLoCoInnerLoop,
  DiLoCoTrainerHelper,
  type DiLoCoProgressUpdate,
  type SpawnFn,
  type StatFn,
} from '../modules/model/diloco-trainer';

function makeSpawnMock(lines: string[], exitCode = 0): ReturnType<SpawnFn> {
  const proc = new EventEmitter();
  const stdin = new EventEmitter();
  (stdin as unknown as Record<string, unknown>)['write'] = () => true;
  (stdin as unknown as Record<string, unknown>)['end'] = () => {};
  (proc as unknown as Record<string, unknown>)['stdin'] = stdin;
  const stdout = new EventEmitter();
  (proc as unknown as Record<string, unknown>)['stdout'] = stdout;
  (proc as unknown as Record<string, unknown>)['stderr'] = new EventEmitter();
  setImmediate(() => {
    for (const l of lines) stdout.emit('data', Buffer.from(l + '\n'));
    proc.emit('close', exitCode);
  });
  return proc as ReturnType<SpawnFn>;
}

function makeErrorSpawnMock(errMsg: string): ReturnType<SpawnFn> {
  const proc = new EventEmitter();
  const stdin = new EventEmitter();
  (stdin as unknown as Record<string, unknown>)['write'] = () => true;
  (stdin as unknown as Record<string, unknown>)['end'] = () => {};
  (proc as unknown as Record<string, unknown>)['stdin'] = stdin;
  (proc as unknown as Record<string, unknown>)['stdout'] = new EventEmitter();
  (proc as unknown as Record<string, unknown>)['stderr'] = new EventEmitter();
  setImmediate(() => proc.emit('error', new Error(errMsg)));
  return proc as ReturnType<SpawnFn>;
}

const mockStatFn: StatFn = (_path) => ({ size: 512 });
const throwingStatFn: StatFn = (_path) => { throw new Error('ENOENT'); };

describe('E2 — runDiLoCoInnerLoop', () => {
  let mockSpawn: jest.MockedFunction<SpawnFn>;

  beforeEach(() => {
    mockSpawn = jest.fn<SpawnFn>();
  });

  it('returns DiLoCoResult with progress updates', async () => {
    const lines = [
      JSON.stringify({ step: 10, loss: 3.45, lr: 0.0002 }),
      JSON.stringify({ step: 20, loss: 3.31, lr: 0.0002 }),
      JSON.stringify({ result: { finalLoss: 3.0, valLoss: 3.1, innerSteps: 20, durationMs: 5000, gradientPath: '/tmp/g.pt' } }),
    ];
    mockSpawn.mockReturnValue(makeSpawnMock(lines));
    const progress: DiLoCoProgressUpdate[] = [];
    const r = await runDiLoCoInnerLoop(
      { modelId: 'Qwen/Qwen2.5-7B', datasetPath: '/tmp/d.txt', innerSteps: 20, hyperparams: { learningRate: 0.0002 }, hardware: 'cpu', testMode: true },
      p => progress.push(p),
      mockSpawn,
      mockStatFn,
    );
    expect(r.finalLoss).toBe(3.0);
    expect(r.valLoss).toBe(3.1);
    expect(r.gradientPath).toBe('/tmp/g.pt');
    expect(r.gradientSizeBytes).toBe(512);
    expect(progress).toHaveLength(2);
    expect(progress[0].step).toBe(10);
    expect(progress[1].loss).toBe(3.31);
  });

  it('rejects on non-zero exit code', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock([], 1));
    await expect(runDiLoCoInnerLoop(
      { modelId: 'x', datasetPath: '/tmp/d.txt', innerSteps: 1, hyperparams: {}, hardware: 'cpu' },
      undefined, mockSpawn, mockStatFn,
    )).rejects.toThrow('exited with code 1');
  });

  it('rejects when no result received', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock([JSON.stringify({ step: 1, loss: 1.0, lr: 0.001 })]));
    await expect(runDiLoCoInnerLoop(
      { modelId: 'x', datasetPath: '/tmp/d.txt', innerSteps: 1, hyperparams: {}, hardware: 'cpu' },
      undefined, mockSpawn, mockStatFn,
    )).rejects.toThrow('no result received');
  });

  it('rejects when error line in stdout', async () => {
    mockSpawn.mockReturnValue(makeSpawnMock([JSON.stringify({ error: 'CUDA OOM' })]));
    await expect(runDiLoCoInnerLoop(
      { modelId: 'x', datasetPath: '/tmp/d.txt', innerSteps: 1, hyperparams: {}, hardware: 'cuda' },
      undefined, mockSpawn, mockStatFn,
    )).rejects.toThrow('CUDA OOM');
  });

  it('rejects when spawn errors', async () => {
    mockSpawn.mockReturnValue(makeErrorSpawnMock('ENOENT: python3 not found'));
    await expect(runDiLoCoInnerLoop(
      { modelId: 'x', datasetPath: '/tmp/d.txt', innerSteps: 1, hyperparams: {}, hardware: 'cpu' },
      undefined, mockSpawn, mockStatFn,
    )).rejects.toThrow('Failed to spawn');
  });

  it('handles non-JSON stdout gracefully', async () => {
    const lines = [
      'some warning',
      JSON.stringify({ step: 1, loss: 2.0, lr: 0.001 }),
      'another log',
      JSON.stringify({ result: { finalLoss: 1.9, valLoss: 2.0, innerSteps: 1, durationMs: 100, gradientPath: '/tmp/g.pt' } }),
    ];
    mockSpawn.mockReturnValue(makeSpawnMock(lines));
    const r = await runDiLoCoInnerLoop(
      { modelId: 'x', datasetPath: '/tmp/d.txt', innerSteps: 1, hyperparams: {}, hardware: 'cpu' },
      undefined, mockSpawn, mockStatFn,
    );
    expect(r.finalLoss).toBe(1.9);
  });

  it('gradientSizeBytes=0 when statFn throws', async () => {
    const line = JSON.stringify({ result: { finalLoss: 1.0, valLoss: 1.1, innerSteps: 1, durationMs: 100, gradientPath: '/nope.pt' } });
    mockSpawn.mockReturnValue(makeSpawnMock([line]));
    const r = await runDiLoCoInnerLoop(
      { modelId: 'x', datasetPath: '/tmp/d.txt', innerSteps: 1, hyperparams: {}, hardware: 'cpu' },
      undefined, mockSpawn, throwingStatFn,
    );
    expect(r.gradientSizeBytes).toBe(0);
  });

  it('DiLoCoTrainerHelper.runDiLoCoInnerLoop delegates correctly', async () => {
    const line = JSON.stringify({ result: { finalLoss: 2.5, valLoss: 2.6, innerSteps: 5, durationMs: 500, gradientPath: '/tmp/h.pt' } });
    mockSpawn.mockReturnValue(makeSpawnMock([line]));
    const helper = new DiLoCoTrainerHelper();
    const r = await helper.runDiLoCoInnerLoop(
      { modelId: 'x', datasetPath: '/tmp/d.txt', innerSteps: 5, hyperparams: {}, hardware: 'cpu' },
      undefined, mockSpawn, mockStatFn,
    );
    expect(r.finalLoss).toBe(2.5);
  });

  it('passes correct script path to spawn', async () => {
    const line = JSON.stringify({ result: { finalLoss: 1.0, valLoss: 1.1, innerSteps: 5, durationMs: 200, gradientPath: '/tmp/a.pt' } });
    mockSpawn.mockReturnValue(makeSpawnMock([line]));
    await runDiLoCoInnerLoop(
      { modelId: 'x', adapterPath: '/tmp/adapter', datasetPath: '/tmp/d.txt', innerSteps: 5, hyperparams: { batchSize: 4 }, hardware: 'mps', pythonScriptPath: '/custom/diloco_train.py' },
      undefined, mockSpawn, mockStatFn,
    );
    expect(mockSpawn).toHaveBeenCalledWith('python3', ['/custom/diloco_train.py'], expect.any(Object));
  });
});

// ======================================================================
// E7: canDiLoCo
// ======================================================================
import { HardwareHelper, canDiLoCo, buildCapabilities, type Hardware } from '../modules/hardware/hardware';

const gpuHw: Hardware = { cpuCores: 8, ramGb: 32, gpuVramGb: 16, tier: 3, hasOllama: false };
const cpuHw: Hardware = { cpuCores: 4, ramGb: 16, gpuVramGb: 0, tier: 0, hasOllama: false };

describe('E7 — canDiLoCo', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('returns false when no GPU', () => {
    expect(new HardwareHelper().canDiLoCo(cpuHw)).toBe(false);
  });

  it('returns false for zero-VRAM hardware', () => {
    const hw0: Hardware = { cpuCores: 4, ramGb: 8, gpuVramGb: 0, tier: 0, hasOllama: false };
    expect(new HardwareHelper().canDiLoCo(hw0)).toBe(false);
  });

  it('returns boolean for GPU hardware (env-dependent)', () => {
    expect(typeof new HardwareHelper().canDiLoCo(gpuHw)).toBe('boolean');
  });

  it('standalone canDiLoCo returns false for cpu hw', () => {
    expect(canDiLoCo(cpuHw)).toBe(false);
  });

  it('buildCapabilities includes diloco when canDiLoCo=true', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(true);
    const caps = helper.buildCapabilities(gpuHw);
    expect(caps).toContain('diloco');
    expect(caps).toContain('gpu');
  });

  it('buildCapabilities does not duplicate gpu', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(true);
    const caps = helper.buildCapabilities(gpuHw);
    expect(caps.filter(c => c === 'gpu').length).toBe(1);
  });

  it('buildCapabilities does not include diloco when canDiLoCo=false', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(false);
    expect(helper.buildCapabilities(gpuHw)).not.toContain('diloco');
  });

  it('buildCapabilities includes cpu for cpu hardware', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canTrain').mockReturnValue(false);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(false);
    const caps = helper.buildCapabilities(cpuHw);
    expect(caps).toContain('cpu');
    expect(caps).not.toContain('gpu');
  });

  it('standalone buildCapabilities returns array with cpu', () => {
    const caps = buildCapabilities(cpuHw);
    expect(Array.isArray(caps)).toBe(true);
    expect(caps).toContain('cpu');
  });

  it('includes training cap when canTrain=true', () => {
    const helper = new HardwareHelper();
    jest.spyOn(helper, 'canTrain').mockReturnValue(true);
    jest.spyOn(helper, 'canDiLoCo').mockReturnValue(false);
    expect(helper.buildCapabilities(gpuHw)).toContain('training');
  });
});
