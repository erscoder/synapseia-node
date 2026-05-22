import {
  detectInstallType,
  InstallType,
  attemptSelfUpdate,
  restartProcess,
  respawnDetached,
  fetchSignedReleaseManifest,
} from '../utils/self-updater';
import { execSync, spawn } from 'child_process';
import { existsSync, statSync, readFileSync } from 'fs';

jest.mock('child_process');
jest.mock('fs');
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock verifyEd25519 + loadCoordinatorPubkey so the spec doesn't need a
// real signing key — F-node-003 manifest-fetch logic is exercised
// end-to-end with a controlled "signature valid / invalid" verdict.
jest.mock('../p2p/protocols/verify-ed25519', () => ({
  verifyEd25519: jest.fn(),
}));
jest.mock('../p2p/protocols/coordinator-pubkey', () => ({
  loadCoordinatorPubkey: jest.fn(() => new Uint8Array(32)),
}));

import { verifyEd25519 } from '../p2p/protocols/verify-ed25519';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockStatSync = statSync as jest.MockedFunction<typeof statSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockVerifyEd25519 = verifyEd25519 as jest.MockedFunction<typeof verifyEd25519>;

const COORD_URL = 'https://coord.example';

/** Build a well-formed signed manifest with a freshly-computed sha256. */
function buildManifest(overrides: Partial<{
  version: string;
  sha256: string;
  signature: string;
  signedAt: number;
}> = {}) {
  return {
    version: '0.9.0',
    sha256: 'a'.repeat(64),
    signature: Buffer.alloc(64).toString('base64'),
    signedAt: Date.now(),
    ...overrides,
  };
}

function mockFetchManifestOnce(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  // @ts-expect-error global fetch mock
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  });
}

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

describe('fetchSignedReleaseManifest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEd25519.mockReturnValue(true);
  });

  it('returns null when /release/latest is unreachable', async () => {
    // @ts-expect-error fetch mock
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns null when /release/latest returns non-2xx', async () => {
    mockFetchManifestOnce({}, { ok: false, status: 404 });
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns null when manifest shape is invalid', async () => {
    mockFetchManifestOnce({ version: '0.9.0' }); // missing sha256/signature/signedAt
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns null when version is not valid semver', async () => {
    mockFetchManifestOnce(buildManifest({ version: 'not-a-version' }));
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns null when sha256 is not 64-char hex', async () => {
    mockFetchManifestOnce(buildManifest({ sha256: 'XYZ' }));
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns null when manifest is stale (> 24h old)', async () => {
    const stale = buildManifest({ signedAt: Date.now() - 25 * 60 * 60 * 1000 });
    mockFetchManifestOnce(stale);
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns null when signature decodes to wrong byte length', async () => {
    mockFetchManifestOnce(buildManifest({ signature: 'AAAA' }));
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns null when Ed25519 verify fails', async () => {
    mockVerifyEd25519.mockReturnValue(false);
    mockFetchManifestOnce(buildManifest());
    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('returns manifest when signature verifies and shape is valid', async () => {
    const m = buildManifest();
    mockFetchManifestOnce(m);
    const result = await fetchSignedReleaseManifest(COORD_URL);
    expect(result).toEqual(m);
    // Verify the canonicalized signed payload includes the three signed fields, NOT signature.
    expect(mockVerifyEd25519).toHaveBeenCalledTimes(1);
    const call = mockVerifyEd25519.mock.calls[0][0];
    const signedPayload = Buffer.from(call.messageBytes).toString('utf-8');
    // Canonical form MUST be coord's sorted-key order (sha256 < signedAt
    // < version) — NOT object-literal insertion order. This asserts the
    // exact wire bytes the coord signer (`ReleaseManifestService.sign`)
    // produces. If anyone reverts to insertion order this fails.
    expect(signedPayload).toBe(
      JSON.stringify({ sha256: m.sha256, signedAt: m.signedAt, version: m.version }),
    );
    const parsed = JSON.parse(signedPayload);
    expect(Object.keys(parsed)).toEqual(['sha256', 'signedAt', 'version']);
    expect(parsed.version).toBe(m.version);
    expect(parsed.sha256).toBe(m.sha256);
    expect(parsed.signedAt).toBe(m.signedAt);
  });
});

describe('attemptSelfUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEd25519.mockReturnValue(true);
  });

  it('refuses install when /release/latest is missing (fail-closed)', async () => {
    // detectInstallType -> NPM_GLOBAL
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === 'npm root -g') return '/usr/local/lib/node_modules\n';
      return '';
    });
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia-network/node/package.json'),
    );
    // @ts-expect-error fetch mock
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await attemptSelfUpdate(COORD_URL);
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
    expect(result.message).toMatch(/Refusing self-update/);
  });

  it('refuses install when tarball sha256 does not match signed manifest', async () => {
    // detectInstallType + npm pack mock
    const fakeBytes = Buffer.from('fake tarball contents');
    const fakeRealSha = require('crypto').createHash('sha256').update(fakeBytes).digest('hex');
    const manifest = buildManifest({ sha256: 'b'.repeat(64) }); // ≠ fakeRealSha

    mockExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      if (s.startsWith('npm pack ')) return 'synapseia-network-node-0.9.0.tgz\n';
      return '';
    });
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s.includes('@synapseia-network/node/package.json') || s.endsWith('.tgz');
    });
    mockStatSync.mockReturnValue({ size: fakeBytes.length } as any);
    mockReadFileSync.mockReturnValue(fakeBytes);
    mockFetchManifestOnce(manifest);

    const result = await attemptSelfUpdate(COORD_URL);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/sha256 mismatch/i);
  });

  it('installs with --ignore-scripts when manifest verifies + sha256 matches', async () => {
    const fakeBytes = Buffer.from('verified tarball contents');
    const realSha = require('crypto').createHash('sha256').update(fakeBytes).digest('hex');
    const manifest = buildManifest({ sha256: realSha });

    const installCmds: string[] = [];
    mockExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      installCmds.push(s);
      if (s === 'npm root -g') return '/usr/local/lib/node_modules\n';
      if (s.startsWith('npm pack ')) return 'synapseia-network-node-0.9.0.tgz\n';
      return '';
    });
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s.includes('@synapseia-network/node/package.json') || s.endsWith('.tgz');
    });
    mockStatSync.mockReturnValue({ size: fakeBytes.length } as any);
    mockReadFileSync.mockReturnValue(fakeBytes);
    mockFetchManifestOnce(manifest);

    const result = await attemptSelfUpdate(COORD_URL);
    expect(result.success).toBe(true);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
    // The install command MUST carry --ignore-scripts AND target the
    // verified tarball path (not @latest from the registry).
    const installCmd = installCmds.find((c) => c.startsWith('npm install -g'));
    expect(installCmd).toBeDefined();
    expect(installCmd).toMatch(/--ignore-scripts/);
    expect(installCmd).not.toMatch(/@latest/);
    expect(installCmd).toMatch(/\.tgz/);
    // npm pack must also carry --ignore-scripts.
    const packCmd = installCmds.find((c) => c.startsWith('npm pack'));
    expect(packCmd).toMatch(/--ignore-scripts/);
    // The packed version MUST come from the signed manifest, not @latest.
    expect(packCmd).toMatch(/@synapseia-network\/node@0\.9\.0/);
  });

  it('refuses install when manifest signature does not verify', async () => {
    mockVerifyEd25519.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === 'npm root -g') return '/usr/local/lib/node_modules\n';
      return '';
    });
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia-network/node/package.json'),
    );
    mockFetchManifestOnce(buildManifest());

    const result = await attemptSelfUpdate(COORD_URL);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Refusing self-update/);
  });

  it('fails gracefully for GIT_CLONE', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockImplementation((p: any) => String(p).endsWith('.git'));

    const result = await attemptSelfUpdate(COORD_URL);
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.GIT_CLONE);
    expect(result.message).toContain('git pull');
  });

  it('returns failure message for UNKNOWN install', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockReturnValue(false);

    const result = await attemptSelfUpdate(COORD_URL);
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.UNKNOWN);
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

// ── REAL sign→verify round-trip (BLOCKER-2 regression guard) ─────────────────
//
// Every other test in this file MOCKS the crypto verdict, which is exactly
// why the canonical key-order drift (coord signs sorted {sha256,signedAt,
// version}; node was verifying insertion-order {version,sha256,signedAt})
// went undetected — verify always returned `true` regardless of the bytes.
//
// This block exercises the node's REAL verification path end-to-end:
//   - generate a throwaway Ed25519 keypair with node:crypto;
//   - sign a manifest EXACTLY as coord does (ReleaseManifestService.sign):
//       crypto.sign(null, UTF-8(JSON.stringify({sha256, signedAt, version})), priv)
//     where the keys are in ASCENDING order;
//   - inject the keypair's RAW 32-byte public key as the trust anchor
//     (loadCoordinatorPubkey mock) and delegate the global verifyEd25519
//     mock to the REAL implementation (jest.requireActual);
//   - drive fetchSignedReleaseManifest and assert ACCEPT for a faithful
//     manifest and REJECT for tampered version / tampered sha256 / a
//     payload signed in the WRONG (insertion) key order.
//
// If anyone reintroduces a key-order or canonical-format drift between the
// signer and the verifier, the "accepts" case here flips to null and fails.
describe('fetchSignedReleaseManifest — REAL Ed25519 round-trip (no crypto mock)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = require('crypto') as typeof import('crypto');
  const { loadCoordinatorPubkey: mockLoadPubkey } =
    require('../p2p/protocols/coordinator-pubkey') as {
      loadCoordinatorPubkey: jest.Mock;
    };
  // The REAL verifier — bypasses the global jest.mock for this block only.
  const realVerifyEd25519 = jest.requireActual(
    '../p2p/protocols/verify-ed25519',
  ).verifyEd25519 as typeof verifyEd25519;

  // ASN.1 DER prefix for an Ed25519 SPKI key — strip it to get the raw
  // 32-byte public key (mirrors verify-ed25519.ts wrapping it back on).
  const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

  let rawPubkey: Uint8Array;
  let privateKey: import('crypto').KeyObject;

  /** Coord-faithful canonical form: keys sorted ASC, no whitespace. */
  function canonicalSorted(m: { sha256: string; signedAt: number; version: string }): string {
    return JSON.stringify({ sha256: m.sha256, signedAt: m.signedAt, version: m.version });
  }

  /** Sign canonical bytes with the test private key, base64-encoded. */
  function signB64(canonical: string): string {
    return nodeCrypto
      .sign(null, Buffer.from(canonical, 'utf-8'), privateKey)
      .toString('base64');
  }

  beforeAll(() => {
    const kp = nodeCrypto.generateKeyPairSync('ed25519');
    privateKey = kp.privateKey;
    const spki = kp.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    // Raw key is the trailing 32 bytes after the fixed SPKI prefix.
    rawPubkey = new Uint8Array(spki.subarray(ED25519_SPKI_PREFIX.length));
    expect(rawPubkey.length).toBe(32);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Trust anchor = the test keypair's raw public key.
    mockLoadPubkey.mockReturnValue(rawPubkey);
    // Route the (globally mocked) verifyEd25519 to the REAL implementation
    // so the signature math actually runs against the canonical bytes.
    mockVerifyEd25519.mockImplementation((params) => realVerifyEd25519(params));
  });

  it('ACCEPTS a manifest signed exactly as coord signs it (sorted-key canonical)', async () => {
    const base = { version: '0.9.0', sha256: 'b'.repeat(64), signedAt: Date.now() };
    const manifest = { ...base, signature: signB64(canonicalSorted(base)) };
    mockFetchManifestOnce(manifest);

    const result = await fetchSignedReleaseManifest(COORD_URL);
    expect(result).toEqual(manifest); // accepted: real verify returned true
  });

  it('REJECTS a manifest whose version was tampered after signing', async () => {
    const base = { version: '0.9.0', sha256: 'c'.repeat(64), signedAt: Date.now() };
    const signature = signB64(canonicalSorted(base));
    // Attacker bumps the served version but cannot re-sign.
    mockFetchManifestOnce({ ...base, version: '9.9.9', signature });

    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('REJECTS a manifest whose sha256 was tampered after signing', async () => {
    const base = { version: '0.9.0', sha256: 'd'.repeat(64), signedAt: Date.now() };
    const signature = signB64(canonicalSorted(base));
    // Attacker swaps the pinned tarball hash to point at a malicious build.
    mockFetchManifestOnce({ ...base, sha256: 'e'.repeat(64), signature });

    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });

  it('REJECTS a manifest signed with the WRONG canonical key order (drift guard)', async () => {
    const base = { version: '0.9.0', sha256: 'f'.repeat(64), signedAt: Date.now() };
    // Sign the OLD buggy insertion order {version, sha256, signedAt}. The
    // verifier canonicalizes to sorted order, so this signature is over a
    // different byte string and MUST be rejected. This is the exact
    // BLOCKER-1 regression: if the verifier reverts to insertion order,
    // this signature would (wrongly) verify and this assertion would fail.
    const wrongOrder = JSON.stringify({
      version: base.version,
      sha256: base.sha256,
      signedAt: base.signedAt,
    });
    mockFetchManifestOnce({ ...base, signature: signB64(wrongOrder) });

    expect(await fetchSignedReleaseManifest(COORD_URL)).toBeNull();
  });
});
