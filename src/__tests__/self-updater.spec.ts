import {
  detectInstallType,
  InstallType,
  attemptSelfUpdate,
  restartProcess,
  respawnDetached,
  verifyInstalledPackage,
  resolveSelfUpdateTimeoutMs,
} from '../utils/self-updater';
import { execSync, spawn } from 'child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync,
} from 'fs';

jest.mock('child_process');
jest.mock('fs');
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockStatSync = statSync as jest.MockedFunction<typeof statSync>;
const mockRenameSync = renameSync as jest.MockedFunction<typeof renameSync>;
const mockRmSync = rmSync as jest.MockedFunction<typeof rmSync>;

const TARGET_VERSION = '0.8.106';
const PKG_NAME = '@synapseia-network/node';

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

describe('resolveSelfUpdateTimeoutMs', () => {
  it('defaults to 600_000 (10 min) when env var is unset', () => {
    expect(resolveSelfUpdateTimeoutMs({})).toBe(600_000);
  });

  it('honours a positive integer SYN_SELFUPDATE_TIMEOUT_MS override', () => {
    expect(resolveSelfUpdateTimeoutMs({ SYN_SELFUPDATE_TIMEOUT_MS: '900000' })).toBe(900_000);
  });

  it('ignores a non-numeric / non-positive / non-integer override', () => {
    expect(resolveSelfUpdateTimeoutMs({ SYN_SELFUPDATE_TIMEOUT_MS: 'abc' })).toBe(600_000);
    expect(resolveSelfUpdateTimeoutMs({ SYN_SELFUPDATE_TIMEOUT_MS: '0' })).toBe(600_000);
    expect(resolveSelfUpdateTimeoutMs({ SYN_SELFUPDATE_TIMEOUT_MS: '-5' })).toBe(600_000);
    expect(resolveSelfUpdateTimeoutMs({ SYN_SELFUPDATE_TIMEOUT_MS: '1.5' })).toBe(600_000);
    expect(resolveSelfUpdateTimeoutMs({ SYN_SELFUPDATE_TIMEOUT_MS: '' })).toBe(600_000);
  });

  it('never uses the 120s value that caused the prod corruption loop', () => {
    expect(resolveSelfUpdateTimeoutMs({})).toBeGreaterThan(120_000);
  });
});

describe('verifyInstalledPackage', () => {
  const PKG_DIR = '/prefix/lib/node_modules/@synapseia-network/node';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Wire fs so a COMPLETE, correct-version install verifies clean. Callers
   * pass overrides to simulate the various corruption modes.
   */
  function wireComplete(opts: {
    pkgJsonExists?: boolean;
    pkgJson?: string | null; // null → readFileSync throws
    bootstrapExists?: boolean;
    distScriptsEntries?: string[] | null; // null → statSync throws
    scriptsEntries?: string[] | null;
  } = {}) {
    const {
      pkgJsonExists = true,
      pkgJson = JSON.stringify({ name: PKG_NAME, version: TARGET_VERSION }),
      bootstrapExists = true,
      distScriptsEntries = ['build.js'],
      scriptsEntries = ['provision.sh'],
    } = opts;

    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('package.json')) return pkgJsonExists;
      if (s.endsWith('dist/bootstrap.js')) return bootstrapExists;
      return false;
    });
    mockReadFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('package.json')) {
        if (pkgJson === null) throw new Error('EIO read failure');
        return pkgJson as any;
      }
      return '' as any;
    });
    const dirFor = (entries: string[] | null) => {
      if (entries === null) throw new Error('ENOENT');
      return { isDirectory: () => true } as any;
    };
    mockStatSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('dist/scripts')) return dirFor(distScriptsEntries);
      if (s.endsWith(`node/scripts`)) return dirFor(scriptsEntries);
      throw new Error('ENOENT');
    });
    mockReaddirSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('dist/scripts')) return (distScriptsEntries ?? []) as any;
      if (s.endsWith(`node/scripts`)) return (scriptsEntries ?? []) as any;
      return [] as any;
    });
  }

  it('ok:true for a complete, correct-version install', () => {
    wireComplete();
    expect(verifyInstalledPackage(PKG_DIR, TARGET_VERSION)).toEqual({ ok: true });
  });

  it('ok:false when package.json is missing', () => {
    wireComplete({ pkgJsonExists: false });
    const r = verifyInstalledPackage(PKG_DIR, TARGET_VERSION);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/package\.json missing/i);
  });

  it('ok:false when package.json is unparseable', () => {
    wireComplete({ pkgJson: '{ broken json' });
    const r = verifyInstalledPackage(PKG_DIR, TARGET_VERSION);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unparseable/i);
  });

  it('ok:false on wrong version (partial / stale install)', () => {
    wireComplete({ pkgJson: JSON.stringify({ name: PKG_NAME, version: '0.0.1' }) });
    const r = verifyInstalledPackage(PKG_DIR, TARGET_VERSION);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/version mismatch/i);
  });

  it('ok:false on unexpected package name', () => {
    wireComplete({ pkgJson: JSON.stringify({ name: 'evil', version: TARGET_VERSION }) });
    const r = verifyInstalledPackage(PKG_DIR, TARGET_VERSION);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unexpected package name/i);
  });

  it('ok:false when dist/bootstrap.js is missing (truncated dist/)', () => {
    wireComplete({ bootstrapExists: false });
    const r = verifyInstalledPackage(PKG_DIR, TARGET_VERSION);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dist\/bootstrap\.js missing/i);
  });

  it('ok:false when BOTH scripts dirs are empty', () => {
    wireComplete({ distScriptsEntries: [], scriptsEntries: [] });
    const r = verifyInstalledPackage(PKG_DIR, TARGET_VERSION);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/scripts directory missing or empty/i);
  });

  it('ok:true when only ONE scripts dir is present + non-empty', () => {
    wireComplete({ distScriptsEntries: null, scriptsEntries: ['x.sh'] });
    expect(verifyInstalledPackage(PKG_DIR, TARGET_VERSION)).toEqual({ ok: true });
  });

  it('ok:false (never throws) when readFileSync blows up', () => {
    wireComplete({ pkgJson: null });
    const r = verifyInstalledPackage(PKG_DIR, TARGET_VERSION);
    expect(r.ok).toBe(false);
  });
});

describe('attemptSelfUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // @ts-expect-error global fetch spy
    global.fetch = jest.fn();
    // Default fs wiring for the swap helpers (no-ops). Individual tests
    // override existsSync to drive detection + verification.
    mockRenameSync.mockImplementation(() => undefined);
    mockRmSync.mockImplementation(() => undefined);
  });

  /**
   * Wire detectInstallType → NPM_GLOBAL, npm install → success, and a
   * COMPLETE staged tree so verifyInstalledPackage passes. Captures exec argv
   * and the options each install was invoked with.
   */
  function wireHappyPath(): { calls: string[]; opts: any[] } {
    const calls: string[] = [];
    const opts: any[] = [];
    mockExecSync.mockImplementation((cmd: any, o?: any) => {
      const s = String(cmd);
      calls.push(s);
      if (o) opts.push(o);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      return '';
    });
    // existsSync: true for the detect probe (package.json) AND the staged
    // dist/bootstrap.js. False for live .bak/liveDir so swap treats it as a
    // fresh install.
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('@synapseia-network/node/package.json')) return true;
      if (s.endsWith('dist/bootstrap.js')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('package.json')) {
        return JSON.stringify({ name: PKG_NAME, version: TARGET_VERSION }) as any;
      }
      return '' as any;
    });
    mockStatSync.mockImplementation((p: any) => {
      if (String(p).endsWith('dist/scripts')) return { isDirectory: () => true } as any;
      throw new Error('ENOENT');
    });
    mockReaddirSync.mockImplementation((p: any) => {
      if (String(p).endsWith('dist/scripts')) return ['build.js'] as any;
      return [] as any;
    });
    return { calls, opts };
  }

  it('stages → verifies → swaps; installs PINNED version with --ignore-scripts into a STAGING prefix', async () => {
    const { calls, opts } = wireHappyPath();

    const result = await attemptSelfUpdate(TARGET_VERSION);

    expect(result.success).toBe(true);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
    expect(result.message).toMatch(/atomic swap/i);

    const installCmd = calls.find((c) => c.startsWith('npm install -g'));
    expect(installCmd).toBeDefined();
    expect(installCmd).toContain(`@synapseia-network/node@'${TARGET_VERSION}'`);
    expect(installCmd).toMatch(/--ignore-scripts/);
    expect(installCmd).not.toMatch(/@latest/);
    expect(calls.some((c) => c.startsWith('npm pack'))).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();

    // The install must target a STAGING prefix, not the live one, and use the
    // raised default timeout (10 min) — never the 120s prod-failure value.
    const installOpts = opts.find((o) => o?.env?.NPM_CONFIG_PREFIX?.includes('.syn-update-staging-'));
    expect(installOpts).toBeDefined();
    expect(installOpts.timeout).toBe(600_000);

    // A successful swap renames the staged package into the live tree.
    expect(mockRenameSync).toHaveBeenCalled();
  });

  it('honours SYN_SELFUPDATE_TIMEOUT_MS for the install timeout', async () => {
    const { opts } = wireHappyPath();
    process.env.SYN_SELFUPDATE_TIMEOUT_MS = '720000';
    try {
      await attemptSelfUpdate(TARGET_VERSION);
    } finally {
      delete process.env.SYN_SELFUPDATE_TIMEOUT_MS;
    }
    const installOpts = opts.find((o) => o?.env?.NPM_CONFIG_PREFIX?.includes('.syn-update-staging-'));
    expect(installOpts.timeout).toBe(720_000);
  });

  it('FAILED verification → live install untouched (no rename swap), staging purged', async () => {
    const calls: string[] = [];
    mockExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      calls.push(s);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      return '';
    });
    // Detect passes, but the STAGED package.json reports the WRONG version →
    // integrity fails, so the swap must NEVER run.
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('@synapseia-network/node/package.json')) return true;
      if (s.endsWith('dist/bootstrap.js')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation(
      () => JSON.stringify({ name: PKG_NAME, version: '0.0.1-wrong' }) as any,
    );

    const result = await attemptSelfUpdate(TARGET_VERSION);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/integrity check/i);
    // HARD GUARANTEE: a failed verify never swaps the live package.
    expect(mockRenameSync).not.toHaveBeenCalled();
    // Staging must be cleaned up.
    expect(mockRmSync).toHaveBeenCalled();
  });

  it('install timeout/throw → fail-closed, staging purged, no swap, no throw', async () => {
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia-network/node/package.json'),
    );
    mockExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      if (s.startsWith('npm install -g')) {
        const e = new Error('ETIMEDOUT') as any;
        e.code = 'ETIMEDOUT';
        throw e;
      }
      return '';
    });

    const result = await attemptSelfUpdate(TARGET_VERSION);
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
    expect(result.message).toMatch(/failed/i);
    // No swap on a failed install → live binary intact.
    expect(mockRenameSync).not.toHaveBeenCalled();
    // Staging dir cleaned up in the catch.
    expect(mockRmSync).toHaveBeenCalled();
  });

  it('preserves the EACCES operator hint on a permission error', async () => {
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia-network/node/package.json'),
    );
    mockExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      if (s.startsWith('npm install -g')) throw new Error('EACCES: permission denied');
      return '';
    });

    const result = await attemptSelfUpdate(TARGET_VERSION);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/permission error/i);
    expect(result.message).toMatch(/sudo npm install/i);
  });

  it('refuses install when target version is not valid semver (no install spawned)', async () => {
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

    const result = await attemptSelfUpdate('not-a-version');

    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
    expect(result.message).toMatch(/not valid semver/i);
    expect(calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
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
