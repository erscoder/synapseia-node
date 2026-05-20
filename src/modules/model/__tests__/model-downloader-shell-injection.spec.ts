/**
 * F-node-010 (MED) regression — `ensureBaseModel` shell injection defense.
 *
 * Pre-fix the function built a shell string interpolating `modelId` and
 * `cacheDir` directly into `python -c "...snapshot_download('${modelId}',
 * local_dir='${cacheDir}')..."`. A coordinator pushing a hostile modelId
 * like `foo'); __import__("os").system("touch /tmp/p0wned");#` would have
 * popped a shell. The new path uses spawnSync(python, ['-c', SCRIPT]) and
 * feeds inputs through stdin JSON, with an allowlist regex on modelId as
 * a defense-in-depth net.
 */
import { mkdtempSync, rmSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModelDownloaderHelper, type SpawnSyncFn } from '../model-downloader';

describe('F-node-010 — ensureBaseModel shell-injection defense', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'syn-mdl-'));
  });
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('rejects shell-meta in modelId BEFORE spawning python', async () => {
    const helper = new ModelDownloaderHelper();
    const spawnFn: SpawnSyncFn = jest.fn() as unknown as SpawnSyncFn;
    // Each of these would be a working shell-inject under the old
    // string-concat path. They MUST all be rejected by the allowlist.
    const hostile = [
      "foo'); __import__('os').system('touch /tmp/p0wn');#",
      'foo; rm -rf /',
      'foo`whoami`',
      'foo$IFS$9bar',
      'foo|cat /etc/passwd',
      'foo && touch /tmp/p',
      'foo\nbar',
      'foo with spaces',
    ];
    for (const modelId of hostile) {
      await expect(
        helper.ensureBaseModel(modelId, false, tmpHome, undefined, spawnFn),
      ).rejects.toThrow(/Invalid model id/);
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('accepts canonical HuggingFace ids and spawns python with argv (no shell)', async () => {
    const helper = new ModelDownloaderHelper();
    const spawnFn = jest.fn().mockReturnValue({
      status: 0,
      pid: 1,
      output: [],
      stdout: '',
      stderr: '',
      signal: null,
      error: undefined,
    } as unknown) as unknown as SpawnSyncFn;

    await helper.ensureBaseModel('Qwen/Qwen2.5-7B', false, tmpHome, undefined, spawnFn);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, args, opts] = (spawnFn as unknown as jest.Mock).mock.calls[0];
    // argv shape: ['-c', PYTHON_SCRIPT]; values flow via stdin, not argv.
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('snapshot_download');
    // Sensitive values must NOT appear in argv — they should be on stdin.
    expect(args[1]).not.toContain('Qwen/Qwen2.5-7B');
    // Stdin payload must include both pieces.
    const stdinPayload = JSON.parse(opts.input as string);
    expect(stdinPayload.modelId).toBe('Qwen/Qwen2.5-7B');
    expect(stdinPayload.cacheDir).toContain('Qwen__Qwen2.5-7B');
  });

  it('rejects empty / oversized modelId', async () => {
    const helper = new ModelDownloaderHelper();
    await expect(helper.ensureBaseModel('', false, tmpHome)).rejects.toThrow(/Invalid model id/);
    await expect(helper.ensureBaseModel('x'.repeat(300), false, tmpHome)).rejects.toThrow(/Invalid model id/);
  });

  it('surfaces python non-zero exit as a failure', async () => {
    const helper = new ModelDownloaderHelper();
    const spawnFn = jest.fn().mockReturnValue({
      status: 1,
      pid: 1,
      output: [],
      stdout: '',
      stderr: 'snapshot_download: network error',
      signal: null,
      error: undefined,
    } as unknown) as unknown as SpawnSyncFn;
    await expect(
      helper.ensureBaseModel('Qwen/Qwen2.5-7B', false, tmpHome, undefined, spawnFn),
    ).rejects.toThrow(/python snapshot_download exited with status 1/);
  });
});
