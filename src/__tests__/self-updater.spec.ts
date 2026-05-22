import {
  detectInstallType,
  InstallType,
  attemptSelfUpdate,
  restartProcess,
  respawnDetached,
} from '../utils/self-updater';
import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';

jest.mock('child_process');
jest.mock('fs');
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

const TARGET_VERSION = '0.8.106';

describe('detectInstallType', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('detects NPM_GLOBAL when package exists in npm root', () => {
    mockExecSync.mockReturnValue('/usr/local/lib/node_modules\n');
    mockExistsSync.mockImplementation((p: any) => {
      return String(p).includes('@synapseia-network/node/package.json');
    });
    expect(detectInstallType()).toBe(InstallType.NPM_GLOBAL);
  });

  it('detects GIT_CLONE when .git exists in package root', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockImplementation((p: any) => {
      return String(p).endsWith('.git');
    });
    expect(detectInstallType()).toBe(InstallType.GIT_CLONE);
  });

  it('returns UNKNOWN when no install type matches', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockReturnValue(false);
    expect(detectInstallType()).toBe(InstallType.UNKNOWN);
  });
});

describe('attemptSelfUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no coord URL is ever fetched on the install path. Wire a
    // fetch spy so any accidental network call is observable + asserted off.
    // @ts-expect-error global fetch spy
    global.fetch = jest.fn();
  });

  /** Make detectInstallType resolve to NPM_GLOBAL and capture exec argv. */
  function wireNpmGlobal(): string[] {
    const calls: string[] = [];
    mockExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      calls.push(s);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      return '';
    });
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia-network/node/package.json'),
    );
    return calls;
  }

  it('installs the PINNED npm version with --ignore-scripts and fetches NO coord URL', async () => {
    const calls = wireNpmGlobal();

    const result = await attemptSelfUpdate(TARGET_VERSION);

    expect(result.success).toBe(true);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);

    // Exact install argv: pinned version + --ignore-scripts, never @latest.
    const installCmd = calls.find((c) => c.startsWith('npm install -g'));
    expect(installCmd).toBeDefined();
    expect(installCmd).toContain(`@synapseia-network/node@'${TARGET_VERSION}'`);
    expect(installCmd).toMatch(/--ignore-scripts/);
    expect(installCmd).not.toMatch(/@latest/);
    // No tarball / npm pack step anymore — install is direct from the registry.
    expect(calls.some((c) => c.startsWith('npm pack'))).toBe(false);
    // The signed-manifest coord round-trip is gone: nothing is fetched.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses install when target version is not valid semver (no install spawned)', async () => {
    const calls = wireNpmGlobal();

    const result = await attemptSelfUpdate('not-a-version');

    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
    expect(result.message).toMatch(/not valid semver/i);
    expect(calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('install spawn failure → fail-closed, no throw', async () => {
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia-network/node/package.json'),
    );
    mockExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      if (s.startsWith('npm install -g')) throw new Error('ENOSPC: no space left');
      return '';
    });

    const result = await attemptSelfUpdate(TARGET_VERSION);
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
    expect(result.message).toMatch(/failed/i);
  });

  it('fails gracefully for GIT_CLONE (no install spawned)', async () => {
    const calls: string[] = [];
    mockExecSync.mockImplementation((cmd: any) => {
      calls.push(String(cmd));
      throw new Error('not npm');
    });
    mockExistsSync.mockImplementation((p: any) => String(p).endsWith('.git'));

    const result = await attemptSelfUpdate(TARGET_VERSION);
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.GIT_CLONE);
    expect(result.message).toContain('git pull');
    expect(calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('returns failure message for UNKNOWN install (no install spawned)', async () => {
    const calls: string[] = [];
    mockExecSync.mockImplementation((cmd: any) => {
      calls.push(String(cmd));
      throw new Error('not npm');
    });
    mockExistsSync.mockReturnValue(false);

    const result = await attemptSelfUpdate(TARGET_VERSION);
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.UNKNOWN);
    expect(calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });
});

describe('restartProcess', () => {
  // The 0.8.21 sudo-free refactor stopped exec-spawning a fresh
  // child process. Restart now just exits 0 and lets the host
  // orchestrator (Tauri shell, systemd, the user's terminal) relaunch
  // the binary with the updated code. The tests assert that contract.
  //
  // F-node-013 (P30) — restartProcess is now async and accepts optional
  // {stopTelemetry, stopP2p} handles so steady-state callers can flush
  // the in-memory telemetry ring (up to 1000 events) before exit.
  const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const mockStdoutLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockExit.mockRestore();
    mockStdoutLog.mockRestore();
  });

  it('exits with code 0 so the host can relaunch', async () => {
    await restartProcess();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('emits the SELF_UPDATE_RESTART cue to stdout', async () => {
    await restartProcess();
    expect(mockStdoutLog).toHaveBeenCalledWith(
      expect.stringContaining('[SELF_UPDATE_RESTART]'),
    );
  });

  it('emits the canonical marker with nonce / version / pid (F-node-ui-004)', async () => {
    // The desktop UI requires a strict-shape marker so a malicious WO /
    // log line cannot trigger a respawn. The shape is:
    //   `[SELF_UPDATE_RESTART] nonce=<value> v<semver> pid=<digits>`
    process.env.SYNAPSEIA_SELF_UPDATE_NONCE = 'deadbeefcafef00d';
    try {
      await restartProcess();
      const markerCall = mockStdoutLog.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' && (c[0] as string).startsWith('[SELF_UPDATE_RESTART] '),
      );
      expect(markerCall).toBeDefined();
      const line = markerCall![0] as string;
      // nonce must echo the env var verbatim.
      expect(line).toContain('nonce=deadbeefcafef00d');
      // version token must be `v<digits>.<digits>.<digits>`.
      expect(line).toMatch(/ v\d+\.\d+\.\d+ /);
      // pid token must be `pid=<digits>` and equal this process pid.
      expect(line).toContain(`pid=${process.pid}`);
    } finally {
      delete process.env.SYNAPSEIA_SELF_UPDATE_NONCE;
    }
  });

  it('emits an empty nonce when SYNAPSEIA_SELF_UPDATE_NONCE is unset', async () => {
    // Shell-invoked runs have no UI parent and no nonce. The marker still
    // gets emitted (for human-visible log tails) but the UI parser
    // rejects empty-nonce markers — so this cannot be abused.
    delete process.env.SYNAPSEIA_SELF_UPDATE_NONCE;
    await restartProcess();
    const markerCall = mockStdoutLog.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('[SELF_UPDATE_RESTART] '),
    );
    expect(markerCall).toBeDefined();
    expect(markerCall![0] as string).toContain('nonce= ');
  });

  it('awaits stopTelemetry + stopP2p before exiting', async () => {
    const stopTelemetry = jest.fn().mockResolvedValue(undefined);
    const stopP2p = jest.fn().mockResolvedValue(undefined);
    await restartProcess({ stopTelemetry, stopP2p });
    expect(stopTelemetry).toHaveBeenCalledTimes(1);
    expect(stopP2p).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('swallows handle errors and still exits cleanly', async () => {
    const stopTelemetry = jest.fn().mockRejectedValue(new Error('flush failed'));
    const stopP2p = jest.fn().mockRejectedValue(new Error('p2p stop failed'));
    await restartProcess({ stopTelemetry, stopP2p });
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('does not block exit past the 5s budget if telemetry hangs', async () => {
    // Hanging promise that never resolves — restartProcess must still
    // call process.exit within ~5s. Use a budget assertion <6000ms.
    const start = Date.now();
    const hang = (): Promise<void> => new Promise<void>(() => undefined);
    await restartProcess({ stopTelemetry: hang, stopP2p: hang });
    expect(Date.now() - start).toBeLessThan(6_000);
    expect(mockExit).toHaveBeenCalledWith(0);
  }, 7_000);
});

describe('respawnDetached', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // @ts-expect-error partial child-process mock — we only assert spawn args
    mockSpawn.mockReturnValue({ unref: jest.fn() });
  });

  it('spawns the same node binary + argv detached, env inherited, and unrefs', () => {
    const ok = respawnDetached();
    expect(ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe(process.execPath);
    // argv[1] (scriptPath) + the rest of argv (user args) re-run verbatim.
    expect(args).toEqual([process.argv[1], ...process.argv.slice(2)]);
    expect(opts).toMatchObject({ detached: true, stdio: 'inherit', env: process.env });
  });

  it('returns false (fail-closed) when spawn throws — never propagates', () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(respawnDetached()).toBe(false);
  });
});

describe('restartProcess — detached respawn gating', () => {
  let mockExit: jest.SpyInstance;
  let mockStdoutLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-install the process.exit + console.log spies each test: a prior
    // describe's afterAll restores the real process.exit, which would kill
    // the jest worker when restartProcess fires for real.
    mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockStdoutLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.SYNAPSEIA_LAUNCH_SOURCE;
    // @ts-expect-error partial child-process mock
    mockSpawn.mockReturnValue({ unref: jest.fn() });
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockStdoutLog.mockRestore();
  });

  afterAll(() => {
    delete process.env.SYNAPSEIA_LAUNCH_SOURCE;
  });

  it('respawn:true + unsupervised run → spawns a replacement and releases the lock first', async () => {
    const releaseLock = jest.fn();
    await restartProcess({ respawn: true, releaseLock });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('respawn:true but UI-supervised → does NOT spawn (UI respawns itself)', async () => {
    process.env.SYNAPSEIA_LAUNCH_SOURCE = 'ui';
    await restartProcess({ respawn: true, releaseLock: jest.fn() });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('respawn omitted → never spawns (legacy clean-exit contract preserved)', async () => {
    await restartProcess();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
