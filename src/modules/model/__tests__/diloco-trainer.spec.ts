/**
 * DiLoCoTrainerHelper — spec covering Bug 18 v3 (local-only runtime).
 *
 * The original pod log showed `[Inner loop failed: diloco_train.py
 * exited with code null]` mid weight-load. v2 added retry + diagnostics
 * but kept HF Hub I/O. v3 eliminates HF Hub from the runtime path
 * entirely — `diloco_train.py` loads with `local_files_only=True` and
 * the foundation model is pre-downloaded by `syn install-deps`.
 *
 * These tests exercise the wrapper's handling of:
 *   1. signal-kill close events → meaningful error message per signal.
 *   2. HF_TOKEN env stripped from child env (no longer needed).
 *   3. non-zero exit-with-code → stderr tail still surfaced.
 *   4. happy path with progress callbacks.
 *
 * spawnFn / statFn are injected so we never touch a real Python.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// Bug 27 (2026-05-17): runDiLoCoInnerLoop now wraps the python spawn in
// an Ollama pause/restart envelope (see modules/llm/ollama-pause.ts).
// Stub the pause helper so this spec stays focused on the spawn
// semantics it was originally written for (no localhost:11434 reach-out,
// no cgroup reads).
jest.mock('../../llm/ollama-pause', () => ({
  maybePauseOllamaForHeavyTraining: jest.fn(async () => ({ wasRunning: false, pausedAt: 0 })),
  maybeRestartOllamaAfterHeavyTraining: jest.fn(async () => undefined),
}));

// Bug 28 (2026-05-17) / Slice 8 (2026-05-17 rename): runDiLoCoInnerLoop now
// also runs ensureMemForHeavyTraining before the spawn. Stub it to a no-op
// so this spec (which only cares about spawn semantics) doesn't trip the
// cgroup-free-mem gate on hosts that genuinely have <18 GB free at test
// time (CI runners are typically 4-7 GB). The preflight logic itself is
// covered by heavy-training-preflight.spec.ts.
jest.mock('../heavy-training-preflight', () => ({
  ensureMemForHeavyTraining: jest.fn(async () => undefined),
  DILOCO_REQUIRED_FREE_MB: 18432,
  LORA_REQUIRED_FREE_MB: 14336,
  InsufficientMemoryError: class InsufficientMemoryError extends Error {
    constructor(msg: string, public readonly freeMB: number, public readonly requiredMB: number) {
      super(msg);
      this.name = 'InsufficientMemoryError';
    }
  },
}));

import { DiLoCoTrainerHelper, type SpawnFn } from '../diloco-trainer';

type AnyFn = (...args: any[]) => any;

/**
 * Build a fake ChildProcess that lets the test drive stdout / stderr /
 * close events imperatively. Mirrors the shape the wrapper consumes
 * (`.stdin.write/end`, `.stdout.on`, `.stderr.on`, `.on('close')`,
 * `.on('error')`, `.kill`).
 */
function makeFakeProc() {
  const stdin = { write: jest.fn(), end: jest.fn() };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as any;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = jest.fn();
  return proc;
}

/**
 * Bug 27 / Slice 8 rename: runDiLoCoInnerLoop now awaits
 * maybePauseOllamaForHeavyTraining() BEFORE calling spawnFn. The pause
 * helper is mocked above to resolve
 * immediately but the `await` still introduces a microtask boundary,
 * so tests must flush microtasks after kicking the promise but BEFORE
 * emitting events on the fake child — otherwise the listeners are not
 * yet attached when the synchronous `proc.emit(...)` fires.
 */
async function flushMicrotasks(): Promise<void> {
  // Two ticks: one for the pause mock's await, one for the inner
  // _spawnDiLoCoTrain to wire up listeners on proc.stdout/stderr/close.
  await Promise.resolve();
  await Promise.resolve();
}

function baseConfig() {
  return {
    modelId: 'fake/model',
    datasetPath: '/tmp/ds.txt',
    innerSteps: 4,
    hyperparams: { learningRate: 1e-3 },
    hardware: 'cpu' as const,
    testMode: false,
    pythonScriptPath: '/fake/diloco_train.py',
  };
}

describe('DiLoCoTrainerHelper (Bug 18 v3)', () => {
  let helper: DiLoCoTrainerHelper;

  beforeEach(() => {
    helper = new DiLoCoTrainerHelper();
  });

  afterEach(() => {
    delete process.env.HF_TOKEN;
  });

  it('surfaces SIGKILL with OOM hint when child is killed (code=null, signal=SIGKILL)', async () => {
    const proc = makeFakeProc();
    const spawnFn = jest.fn(() => proc) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 0 }));

    const pending = helper.runDiLoCoInnerLoop(baseConfig(), undefined, spawnFn, statFn);
    await flushMicrotasks();

    // Emit some HF tqdm-ish stderr noise, then signal-kill.
    proc.stderr.emit('data', Buffer.from('Loading weights: 244/339\n'));
    proc.emit('close', null, 'SIGKILL');

    await expect(pending).rejects.toThrow(/killed by signal SIGKILL/);
    await expect(pending).rejects.toThrow(/OOM-killer or container memory limit/);
  });

  it('surfaces SIGSEGV with native-crash hint (safetensors/hf_transfer)', async () => {
    const proc = makeFakeProc();
    const spawnFn = jest.fn(() => proc) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 0 }));

    const pending = helper.runDiLoCoInnerLoop(baseConfig(), undefined, spawnFn, statFn);
    await flushMicrotasks();
    proc.emit('close', null, 'SIGSEGV');

    await expect(pending).rejects.toThrow(/SIGSEGV/);
    await expect(pending).rejects.toThrow(/native crash/);
  });

  it('surfaces SIGPIPE with local-only hint and stderr tail', async () => {
    const proc = makeFakeProc();
    const spawnFn = jest.fn(() => proc) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 0 }));

    const pending = helper.runDiLoCoInnerLoop(baseConfig(), undefined, spawnFn, statFn);
    await flushMicrotasks();
    proc.stderr.emit('data', Buffer.from('BrokenPipeError: [Errno 32] Broken pipe\n'));
    proc.emit('close', null, 'SIGPIPE');

    await expect(pending).rejects.toThrow(/SIGPIPE/);
    await expect(pending).rejects.toThrow(/broken pipe/);
    await expect(pending).rejects.toThrow(/Broken pipe/);
  });

  it('Bug 18 v3: HF_TOKEN is stripped from child env (runtime is local-only)', async () => {
    process.env.HF_TOKEN = 'hf_test_token_abc';
    const proc = makeFakeProc();
    const spawnFn = jest.fn((_cmd: string, _args: string[], options: any) => {
      // Assert HF_TOKEN was scrubbed before spawn so the Python child
      // cannot use it for any model load (local_files_only=True forbids
      // Hub I/O anyway, but defense-in-depth).
      expect(options.env).toBeDefined();
      expect(options.env.HF_TOKEN).toBeUndefined();
      return proc;
    }) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 0 }));

    const pending = helper.runDiLoCoInnerLoop(baseConfig(), undefined, spawnFn, statFn);
    await flushMicrotasks();
    proc.emit('close', 1, null);
    await expect(pending).rejects.toThrow(/exited with code 1/);
    expect(spawnFn).toHaveBeenCalled();
  });

  it('Bug 18 v3: HF_TOKEN absent from child env when also absent from parent (no leak)', async () => {
    delete process.env.HF_TOKEN;
    const proc = makeFakeProc();
    const spawnFn = jest.fn((_cmd: string, _args: string[], options: any) => {
      expect(options.env.HF_TOKEN).toBeUndefined();
      return proc;
    }) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 0 }));

    const pending = helper.runDiLoCoInnerLoop(baseConfig(), undefined, spawnFn, statFn);
    await flushMicrotasks();
    proc.emit('close', 1, null);
    await expect(pending).rejects.toThrow(/exited with code 1/);
  });

  it('non-zero exit code includes stderr tail (capped to last 512 bytes of message)', async () => {
    const proc = makeFakeProc();
    const spawnFn = jest.fn(() => proc) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 0 }));

    const pending = helper.runDiLoCoInnerLoop(baseConfig(), undefined, spawnFn, statFn);
    await flushMicrotasks();
    proc.stderr.emit('data', Buffer.from('Traceback ...\nValueError: bad config\n'));
    proc.emit('close', 1, null);

    await expect(pending).rejects.toThrow(/exited with code 1/);
    await expect(pending).rejects.toThrow(/bad config/);
  });

  it('happy path: emits progress + resolves with final result', async () => {
    const proc = makeFakeProc();
    const spawnFn = jest.fn(() => proc) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 1234 }));

    const progress: any[] = [];
    const pending = helper.runDiLoCoInnerLoop(
      baseConfig(),
      (u) => progress.push(u),
      spawnFn,
      statFn,
    );
    await flushMicrotasks();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ step: 1, loss: 2.5, lr: 1e-3 }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ step: 4, loss: 1.2, lr: 1e-3 }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      result: { finalLoss: 1.2, valLoss: 1.26, innerSteps: 4, gradientPath: '/tmp/g.pt' },
    }) + '\n'));
    proc.emit('close', 0, null);

    const result = await pending;
    expect(result.finalLoss).toBe(1.2);
    expect(result.valLoss).toBe(1.26);
    expect(result.innerSteps).toBe(4);
    expect(result.gradientPath).toBe('/tmp/g.pt');
    expect(result.gradientSizeBytes).toBe(1234);
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({ step: 1, loss: 2.5 });
  });

  it('Python-level {error: ...} JSON line rejects with that error', async () => {
    const proc = makeFakeProc();
    const spawnFn = jest.fn(() => proc) as unknown as SpawnFn;
    const statFn = jest.fn(() => ({ size: 0 }));

    const pending = helper.runDiLoCoInnerLoop(baseConfig(), undefined, spawnFn, statFn);
    await flushMicrotasks();
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ error: 'AutoModel.from_pretrained failed after 3 attempts' }) + '\n'));
    proc.emit('close', 1, null);

    await expect(pending).rejects.toThrow(/failed after 3 attempts/);
  });
});
