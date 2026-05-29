/**
 * OS-aware auto-installer for Vina + Open Babel (docking dependencies).
 *
 * Triggered from the CLI bootstrap path on first boot when:
 *   (a) the node has a GPU detected (caps include `gpu_training` or `gpu_inference`)
 *   (b) `isVinaAvailable()` returns false
 *
 * The install is NON-FATAL: any failure returns `{installed: false, reason}` and
 * the caller MUST NOT abort node boot. The heartbeat probe simply omits `docking`
 * from advertised caps and the coordinator skips docking dispatch.
 *
 * Honors `DISABLE_AUTO_INSTALL_DOCKING=true` env override.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  accessSync,
  mkdirSync,
  readFileSync,
  rmSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';

export interface InstallResult {
  installed: boolean;
  reason?: string;
  durationMs?: number;
}

export interface InstallDockingDepsOptions {
  /** Test-only override of `child_process.execSync`. */
  execSyncFn?: typeof execSync;
  /** Test-only override of `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test-only override of `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Test-only override of the sleep used between package-manager install
   * retries (apt-get and dnf both retry on lock contention).
   * Default: real `setTimeout`-based sleep (30s / 60s / 90s backoff).
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Test-only override of `fs.readFileSync`, used to read the downloaded
   * Vina binary bytes for checksum verification. Lets tests inject the
   * "downloaded" bytes without touching the real filesystem.
   * Default: real `readFileSync`.
   */
  readFileFn?: (p: string) => Buffer;
  /**
   * Test-only override of the "is the Vina binary already present?" check.
   * Default: real `existsSync` + `accessSync(X_OK)`. Tests pass `() => false`
   * to deterministically force the download+checksum path regardless of
   * whatever happens to live in the dev machine's `~/.synapseia/bin/`.
   */
  vinaAlreadyReadyFn?: (vinaBinPath: string) => boolean;
  /**
   * Test-only override of the expected (pinned) SHA-256 for the Vina asset.
   * Default: the production `VINA_SHA256` map keyed by (version, arch).
   *
   * This exists ONLY so tests can drive the post-checksum paths (chmod,
   * `--version` probe) with arbitrary injected bytes — they set this to the
   * sha256 of their own fixture. Production code NEVER passes it, so the
   * real pinned digests are always used at runtime.
   */
  expectedSha256Fn?: (version: string, arch: string) => string | undefined;
}

/**
 * Pinned SHA-256 digests for each (version, arch) AutoDock-Vina macOS GitHub
 * release asset. These are the SUPPLY-CHAIN trust anchors: a downloaded
 * binary is executed (chmod +x → `--version` probe → later docking runs)
 * ONLY if its bytes hash to the value pinned here.
 *
 * Why pin instead of trusting `curl -f`: `-f` only rejects HTTP 4xx/5xx. A
 * compromised release asset, a MITM on a downgraded TLS path, a CDN cache
 * poisoning, or a typo-squatted mirror redirect can all serve a 200-OK body
 * that is a malicious Mach-O. Without a pinned digest we'd `chmod +x` and
 * execute attacker-controlled bytes on the operator's host.
 *
 * Key = `vina_<version>_mac_<arch>` (the exact GH asset filename, matching
 * the curl URL tail). To add/rotate a version: download the official asset
 * over https, `shasum -a 256 <file>`, and paste the digest here. Do NOT
 * accept a digest from any source other than a trusted, manually-verified
 * download of the upstream release.
 *
 * If a (version, arch) is NOT pinned here, the installer FAILS CLOSED:
 * it reports `installed:false` and never executes the binary. This is the
 * safe default for an optional, best-effort install — a missing pin must
 * never degrade into "execute whatever was downloaded".
 */
const VINA_SHA256: Readonly<Record<string, string>> = {
  // AutoDock-Vina v1.2.5 macOS release assets.
  // ccsb-scripps/AutoDock-Vina releases/download/v1.2.5/vina_1.2.5_mac_<arch>
  //
  // Real SHA-256 sums, backfilled 2026-05-29. AutoDock-Vina does NOT publish
  // a checksums file, so these are computed directly from the official GitHub
  // release binaries: `curl -fsSL <release-url> -o vina && shasum -a 256 vina`.
  // (aarch64 = 1171224 bytes, x86_64 = 1297344 bytes.) This is the integrity
  // gate for a fresh macOS install: a download whose digest does not match
  // fails closed (no chmod, no execution). To re-verify or bump the version,
  // re-download each asset over https and recompute the sum.
  vina_1_2_5_mac_aarch64:
    '4999b3133f162b66d8b21bafdb54aa53c507ed6347489844e6778dac7871ff5f',
  vina_1_2_5_mac_x86_64:
    'de9402701fba0f69bce53aec94254a08a7044c7d1d459958896022a7f98b073d',
};

/**
 * Build the `VINA_SHA256` lookup key for a (version, arch) pair. Version
 * dots are replaced with underscores so the key is a valid identifier and
 * matches the constant above (`1.2.5` → `1_2_5`).
 */
function vinaSha256Key(version: string, arch: string): string {
  return `vina_${version.replace(/\./g, '_')}_mac_${arch}`;
}

/** Hex SHA-256 of a buffer. */
function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Exit code returned by apt-get when the dpkg / apt lock is held. */
const APT_LOCK_EXIT_CODE = 100;

/**
 * Backoff schedule (ms) for package-manager install retries on lock
 * contention. Both apt-get and dnf use the same schedule because the
 * underlying root cause (another package operation in flight on the host)
 * has the same physical timescale.
 */
const PM_RETRY_BACKOFF_MS = [30_000, 60_000, 90_000];

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Extract exit code from a thrown `execSync` error. Node sets `.status` to
 * the child exit code; `null` means the process was killed by signal. We
 * map `null` to `-1` so the caller can branch deterministically.
 *
 * Exported for direct unit-test coverage (it is the entire retry-loop
 * trigger; shape variance across thrown-error shapes must be pinned).
 */
export function extractExitCode(err: unknown): number {
  const status = (err as { status?: number | null } | null)?.status;
  if (typeof status === 'number') return status;
  return -1;
}

/**
 * Extract stderr tail (last `maxChars`) from a thrown `execSync` error.
 * Falls back to `.message` when stderr is absent (stub-injected errors).
 *
 * Exported for direct unit-test coverage (it is the only operator-visible
 * surface of what the package manager actually said when an install fails).
 */
export function extractStderrTail(err: unknown, maxChars = 500): string {
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr;
  let text: string;
  if (Buffer.isBuffer(stderr)) {
    text = stderr.toString('utf8');
  } else if (typeof stderr === 'string') {
    text = stderr;
  } else {
    text = (err as Error)?.message ?? '';
  }
  text = text.trim();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/**
 * dnf returns exit code 1 for almost everything — unknown package, network,
 * gpg failure, AND lock contention. So we can't branch on exit code like
 * apt-get; we have to parse stderr for the lock-held signal. Matches:
 *   - "Error: Failed to obtain the lock ..."
 *   - "another instance of dnf is running"
 *   - "Waiting for process N to finish"  (some distros emit this)
 *
 * Case-insensitive. Conservative: only trips on clear lock indicators so
 * non-lock failures (unknown pkg, network) bail immediately and don't burn
 * 3 retries × 90s waiting for nothing.
 */
function isDnfLockHeld(err: unknown): boolean {
  const tail = extractStderrTail(err, 2000);
  return /failed to obtain the lock|another instance|process \d+/i.test(tail);
}

/**
 * apt-get sets exit code 100 when the dpkg / apt lock is held. Clean signal,
 * no stderr parsing needed.
 */
function isAptLockHeld(err: unknown): boolean {
  return extractExitCode(err) === APT_LOCK_EXIT_CODE;
}

/**
 * Shared install-with-retry loop used by BOTH apt-get and dnf. Centralizing
 * the loop here ensures the two package managers can't drift apart in
 * retry semantics (P10 family — duplicated retry code rots independently).
 *
 * Contract:
 *   - install attempted up to `PM_RETRY_BACKOFF_MS.length` times.
 *   - lock-held failures: sleep then retry.
 *   - non-lock failures: bail IMMEDIATELY with the stderr tail (do NOT
 *     burn the full retry budget on a permanent failure like unknown pkg).
 *   - retry exhaustion: bail with retry-count + stderr tail.
 *
 * Returns `InstallResult` directly. Caller adds `durationMs` from outer t0.
 */
async function installWithLockRetry(opts: {
  packageManager: 'apt-get' | 'dnf';
  installCmd: string;
  isLockHeld: (err: unknown) => boolean;
  exec: typeof execSync;
  sleep: (ms: number) => Promise<void>;
  t0: number;
}): Promise<InstallResult> {
  const { packageManager, installCmd, isLockHeld, exec, sleep, t0 } = opts;
  const totalAttempts = PM_RETRY_BACKOFF_MS.length;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      exec(installCmd, { stdio: 'inherit', timeout: 300_000 });
      return { installed: true, durationMs: Date.now() - t0 };
    } catch (err) {
      lastErr = err;
      if (!isLockHeld(err)) {
        // Non-lock failure — bail. apt-get reports the real exit code;
        // dnf almost always returns 1 so we just say `(exit=1)`. Either
        // way, the stderr tail tells the operator what really happened.
        const exit = extractExitCode(err);
        return {
          installed: false,
          reason: `${packageManager} install failed (exit=${exit}): ${extractStderrTail(err)}`,
          durationMs: Date.now() - t0,
        };
      }
      if (attempt < totalAttempts - 1) {
        await sleep(PM_RETRY_BACKOFF_MS[attempt]);
      }
    }
  }
  return {
    installed: false,
    reason: `${packageManager} install failed after ${totalAttempts} retries (lock contention): ${extractStderrTail(lastErr)}`,
    durationMs: Date.now() - t0,
  };
}

/**
 * Auto-install Vina + Open Babel on the host so the node can advertise the
 * `docking` capability. See module docstring for trigger conditions.
 *
 * Platform support:
 *   - macOS:   `brew install autodock-vina open-babel`
 *   - Linux:   `sudo apt-get install -y autodock-vina openbabel`
 *              falls back to `sudo dnf install -y autodock-vina openbabel`
 *   - Windows: unsupported (returns gracefully)
 *
 * Each install attempt has a 5 min timeout. On Linux, `sudo` is assumed
 * available in pod/container env. If sudo prompts, the install fails
 * non-fatally — the operator can manually install.
 */
export async function installDockingDeps(
  opts?: InstallDockingDepsOptions,
): Promise<InstallResult> {
  const exec = opts?.execSyncFn ?? execSync;
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const sleep = opts?.sleepFn ?? realSleep;
  const readFile = opts?.readFileFn ?? ((p: string) => readFileSync(p));
  const vinaAlreadyReady =
    opts?.vinaAlreadyReadyFn ??
    ((vinaBinPath: string): boolean => {
      if (!existsSync(vinaBinPath)) return false;
      try {
        accessSync(vinaBinPath, fsConstants.X_OK);
        return true;
      } catch {
        // exists but not executable — re-download.
        return false;
      }
    });

  if (env.DISABLE_AUTO_INSTALL_DOCKING === 'true') {
    return {
      installed: false,
      reason: 'disabled by env (DISABLE_AUTO_INSTALL_DOCKING=true)',
    };
  }

  const t0 = Date.now();
  try {
    if (platform === 'darwin') {
      // Step 1: Open Babel via brew (autodock-vina is NOT in homebrew-core).
      exec('brew --version', { stdio: 'pipe', timeout: 5_000 });
      exec('brew install open-babel', {
        stdio: 'inherit',
        timeout: 300_000,
      });

      // Step 2: AutoDock Vina via GitHub release binary.
      const vinaBinPath = path.join(homedir(), '.synapseia', 'bin', 'vina');
      const vinaReady = vinaAlreadyReady(vinaBinPath);
      if (!vinaReady) {
        // GH release asset naming convention (verified live 2026-05-17 against
        // ccsb-scripps/AutoDock-Vina v1.2.5): `vina_<ver>_mac_<arch>` where
        // `<arch>` is `aarch64` (not `arm64`) on Apple Silicon and `x86_64`
        // on Intel. Prior 0.8.55+ template used `macos_arm64` → 404 on every
        // Mac install, silent fail because installer is non-fatal.
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
        const vinaVersion = '1.2.5';
        const vinaUrl = `https://github.com/ccsb-scripps/AutoDock-Vina/releases/download/v${vinaVersion}/vina_${vinaVersion}_mac_${arch}`;

        // Look up the pinned digest BEFORE downloading. If this (version,
        // arch) is not pinned we fail closed immediately — never download +
        // execute an asset we have no trust anchor for. (Supply-chain
        // hardening: a missing pin must not degrade to "trust whatever".)
        const expectedSha = opts?.expectedSha256Fn
          ? opts.expectedSha256Fn(vinaVersion, arch)
          : VINA_SHA256[vinaSha256Key(vinaVersion, arch)];
        if (!expectedSha) {
          return {
            installed: false,
            reason: `no pinned SHA-256 for Vina ${vinaVersion} (${arch}); refusing to download+execute unverified binary`,
            durationMs: Date.now() - t0,
          };
        }

        // Download to disk. NOTE: no `chmod +x` here — the bytes stay
        // untrusted (and non-executable) until the checksum gate passes.
        try {
          mkdirSync(path.dirname(vinaBinPath), { recursive: true });
          exec(`curl -sLf -o "${vinaBinPath}" "${vinaUrl}"`, {
            stdio: 'inherit',
            timeout: 300_000,
          });
        } catch (err) {
          return {
            installed: false,
            reason: `open-babel installed but Vina download failed (${vinaUrl}): ${(err as Error).message}`,
            durationMs: Date.now() - t0,
          };
        }

        // SUPPLY-CHAIN GATE: hash the downloaded bytes and compare against
        // the pinned digest BEFORE making the file executable and BEFORE the
        // `--version` probe. `curl -f` only rejects HTTP errors; it cannot
        // detect a 200-OK malicious/tampered body (compromised release asset,
        // MITM, CDN poisoning, mirror redirect). On mismatch we delete the
        // file and bail NON-FATALLY without ever executing it.
        let actualSha: string;
        try {
          actualSha = sha256Hex(readFile(vinaBinPath));
        } catch (err) {
          try {
            rmSync(vinaBinPath, { force: true });
          } catch {
            /* best-effort */
          }
          return {
            installed: false,
            reason: `Vina downloaded but could not be read for checksum verification: ${(err as Error).message}`,
            durationMs: Date.now() - t0,
          };
        }
        if (actualSha !== expectedSha) {
          // Tampered / wrong bytes — quarantine by deleting, never chmod or run.
          try {
            rmSync(vinaBinPath, { force: true });
          } catch {
            /* best-effort */
          }
          return {
            installed: false,
            reason: `Vina checksum mismatch (expected ${expectedSha}, got ${actualSha}); refusing to execute unverified binary`,
            durationMs: Date.now() - t0,
          };
        }

        // Checksum verified — now it is safe to make the file executable.
        try {
          exec(`chmod +x "${vinaBinPath}"`, { stdio: 'pipe', timeout: 5_000 });
        } catch (err) {
          return {
            installed: false,
            reason: `Vina checksum verified but chmod +x failed: ${(err as Error).message}`,
            durationMs: Date.now() - t0,
          };
        }

        // Post-verify functional probe: a checksum-matched binary can still
        // fail to run (wrong arch slipping through a future arch-mapping bug).
        // Probe `vina --version` so a non-runnable binary is caught here
        // instead of crashing on the first work order.
        try {
          exec(`"${vinaBinPath}" --version`, { stdio: 'pipe', timeout: 10_000 });
        } catch (err) {
          return {
            installed: false,
            reason: `Vina downloaded but --version probe failed: ${(err as Error).message}`,
            durationMs: Date.now() - t0,
          };
        }
      }
      return { installed: true, durationMs: Date.now() - t0 };
    }

    if (platform === 'linux') {
      // Probe apt-get availability FIRST. Only a missing apt-get falls
      // through to dnf. If apt-get exists, all install failures (lock
      // contention, unknown package, signature errors, etc.) stay in the
      // apt-get branch — dnf is for distros that don't ship apt-get at
      // all (RHEL/Fedora/Alma/Rocky), not a retry on a different pm.
      let aptAvailable = false;
      try {
        exec('apt-get --version', { stdio: 'pipe', timeout: 5_000 });
        aptAvailable = true;
      } catch {
        // apt-get not on PATH — try dnf next.
      }

      if (aptAvailable) {
        return installWithLockRetry({
          packageManager: 'apt-get',
          installCmd: 'sudo apt-get install -y autodock-vina openbabel',
          isLockHeld: isAptLockHeld,
          exec,
          sleep,
          t0,
        });
      }

      // Fall back to dnf (RHEL/Fedora) only when apt-get is absent.
      // Probe dnf separately so we can distinguish "no package manager
      // at all" from "dnf install genuinely failed" in the reason text.
      let dnfAvailable = false;
      try {
        exec('dnf --version', { stdio: 'pipe', timeout: 5_000 });
        dnfAvailable = true;
      } catch {
        // dnf not on PATH either.
      }
      if (!dnfAvailable) {
        return {
          installed: false,
          reason: 'no supported package manager found (tried apt-get + dnf)',
          durationMs: Date.now() - t0,
        };
      }

      return installWithLockRetry({
        packageManager: 'dnf',
        installCmd: 'sudo dnf install -y autodock-vina openbabel',
        isLockHeld: isDnfLockHeld,
        exec,
        sleep,
        t0,
      });
    }

    if (platform === 'win32') {
      return {
        installed: false,
        reason: 'Windows not supported — install Vina + Open Babel manually',
        durationMs: Date.now() - t0,
      };
    }

    return {
      installed: false,
      reason: `unsupported platform: ${platform}`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      installed: false,
      reason: (err as Error).message,
      durationMs: Date.now() - t0,
    };
  }
}
