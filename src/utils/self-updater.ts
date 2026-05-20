import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { valid } from 'semver';
import logger from './logger';
import {
  loadCoordinatorPubkey,
} from '../p2p/protocols/coordinator-pubkey';
import { verifyEd25519 } from '../p2p/protocols/verify-ed25519';

// `__filename` is a CJS global in jest and a tsup-injected shim in the
// production ESM bundle (`shims: true` in tsup.config.ts). Both paths
// resolve before any code in this file runs, so we can use it directly.

export enum InstallType {
  NPM_GLOBAL = 'npm_global',
  GIT_CLONE = 'git_clone',
  BINARY = 'binary',
  UNKNOWN = 'unknown',
}

/**
 * Detect how the node CLI was installed.
 */
export function detectInstallType(): InstallType {
  // Prefer a path-based check against THIS module's location: if we're
  // running from any known npm-install layout (user-prefix from a
  // previous self-update, bundled-runtime prefix from install_synapseia_node,
  // or a system prefix), classify as NPM_GLOBAL. `npm root -g` only ever
  // reports the SYSTEM prefix, so the user-prefix install used by the
  // sudo-free self-update path was silently classified as UNKNOWN and
  // the update never ran. Same goes for the bundled-runtime prefix.
  try {
    const myDir = dirname(__filename);
    const NPM_PREFIXES = [
      join(homedir(), '.synapseia', 'npm-global'),
      join(homedir(), '.synapseia', 'node'),
      '/opt/homebrew/lib/node_modules',
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
    ];
    for (const prefix of NPM_PREFIXES) {
      // path-prefix match — accept both flat (npm) and nested (workspace) layouts.
      if (myDir.startsWith(prefix + '/') || myDir === prefix) {
        return InstallType.NPM_GLOBAL;
      }
    }
  } catch { /* fall through */ }

  try {
    // Fallback: `npm root -g` system check covers nvm/volta/fnm layouts
    // we don't hard-code above.
    const npmGlobalRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (existsSync(join(npmGlobalRoot, '@synapseia-network', 'node', 'package.json'))) {
      return InstallType.NPM_GLOBAL;
    }
  } catch { /* not npm global */ }

  // git clone: .git dir exists somewhere up the tree. Walk up from this
  // module's location looking for the first .git/ — robust to dev vs
  // bundled layouts.
  if (findGitRoot(dirname(__filename))) {
    return InstallType.GIT_CLONE;
  }

  // Binary: compiled single-file (Tauri bundles, pkg, etc.)
  if (process.pkg || (process as any).__nexe) {
    return InstallType.BINARY;
  }

  return InstallType.UNKNOWN;
}

export interface SelfUpdateResult {
  success: boolean;
  installType: InstallType;
  message: string;
}

/**
 * Signed release manifest fetched from coord `/release/latest`.
 *
 * Wire shape:
 *   {
 *     "version":   "0.8.94",
 *     "sha256":    "<hex of @synapseia-network/node tarball>",
 *     "signature": "<base64 Ed25519 sig over canonicalized {version,sha256,signedAt}>",
 *     "signedAt":  <unix-ms>
 *   }
 *
 * Verified against the hardcoded `COORDINATOR_PUBKEY_BASE58` trust anchor
 * already used for gossipsub envelopes.
 */
export interface SignedReleaseManifest {
  version: string;
  sha256: string;
  signature: string;
  signedAt: number;
}

/**
 * Resolve the npm prefix the CURRENT binary was installed into. Looks
 * for `/lib/node_modules/@synapseia-network/node` in this module's
 * dirname and returns the parent of `lib/`. Returns null when the
 * layout is unrecognisable (compiled binary, raw dev tree, etc.).
 *
 * Pre-0.8.49 the self-update hard-coded `~/.synapseia/npm-global` as
 * the upgrade target. Operators that installed via a regular
 * `npm i -g` (system prefix `/usr/local` or homebrew-managed) had
 * the update land in the user prefix while their PATH still pointed
 * at the system binary — every boot detected an update and looped
 * because the *running* binary never moved.
 */
function getRunningInstallPrefix(): string | null {
  try {
    const myDir = dirname(__filename);
    const marker = '/lib/node_modules/';
    const idx = myDir.indexOf(marker);
    if (idx >= 0) return myDir.slice(0, idx);
  } catch { /* fall through */ }
  return null;
}

/** Max manifest age accepted before the node refuses the update (replay
 *  defense). 24h — releases are infrequent but routine restarts within a
 *  day are common. Tunable; if a release is older than this, coord just
 *  re-signs on a refresh cycle. */
const MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Tarball size cap. Real node tarball ~3-10 MB; cap well below the
 *  cliff where a malicious manifest could point us at a multi-GB tarball
 *  to DoS the disk. */
const TARBALL_MAX_BYTES = 80 * 1024 * 1024;

/**
 * Fetch + verify the signed release manifest from coord.
 *
 * Returns null on ANY failure (network, missing endpoint, malformed
 * body, bad signature, stale manifest). Callers MUST fail-closed —
 * refuse to install — rather than fall back to `@latest`.
 */
export async function fetchSignedReleaseManifest(
  coordinatorUrl: string,
): Promise<SignedReleaseManifest | null> {
  let resp: Response;
  try {
    resp = await fetch(`${coordinatorUrl}/release/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.warn(`[SelfUpdate] /release/latest unreachable: ${(err as Error).message}`);
    return null;
  }
  if (!resp.ok) {
    logger.warn(`[SelfUpdate] /release/latest returned HTTP ${resp.status}`);
    return null;
  }

  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    logger.warn('[SelfUpdate] /release/latest body is not JSON');
    return null;
  }

  if (!isSignedReleaseManifestShape(raw)) {
    logger.warn('[SelfUpdate] /release/latest payload missing required fields');
    return null;
  }

  // Validate shape values BEFORE crypto work. semver + lowercase hex
  // sha256 are cheap pre-conditions.
  if (!valid(raw.version)) {
    logger.warn(`[SelfUpdate] manifest version "${raw.version}" is not valid semver`);
    return null;
  }
  if (!/^[a-f0-9]{64}$/.test(raw.sha256)) {
    logger.warn('[SelfUpdate] manifest sha256 is not a 64-char lowercase hex string');
    return null;
  }
  if (typeof raw.signedAt !== 'number' || raw.signedAt <= 0) {
    logger.warn('[SelfUpdate] manifest signedAt missing or non-positive');
    return null;
  }

  const ageMs = Date.now() - raw.signedAt;
  if (ageMs > MANIFEST_MAX_AGE_MS) {
    logger.warn(
      `[SelfUpdate] manifest is stale (age=${Math.round(ageMs / 1000)}s, ` +
        `max=${MANIFEST_MAX_AGE_MS / 1000}s). Refusing install.`,
    );
    return null;
  }
  // Small future skew window (clock drift). Reject if > 5 min in the future.
  if (ageMs < -5 * 60 * 1000) {
    logger.warn('[SelfUpdate] manifest signedAt is in the future — clock skew? Refusing install.');
    return null;
  }

  // Canonicalize the signed payload. MUST match the coord-side signer
  // byte-for-byte: keys in fixed order, no whitespace, no trailing
  // newline. JSON.stringify on an object literal with a fixed key order
  // is sufficient because Node preserves insertion order for string keys.
  const signedPayload = JSON.stringify({
    version: raw.version,
    sha256: raw.sha256,
    signedAt: raw.signedAt,
  });

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = Buffer.from(raw.signature, 'base64');
  } catch {
    logger.warn('[SelfUpdate] manifest signature is not valid base64');
    return null;
  }
  if (signatureBytes.length !== 64) {
    logger.warn(
      `[SelfUpdate] manifest signature must decode to 64 bytes; got ${signatureBytes.length}`,
    );
    return null;
  }

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = loadCoordinatorPubkey();
  } catch (err) {
    logger.error(
      `[SelfUpdate] failed to load coordinator pubkey: ${(err as Error).message}`,
    );
    return null;
  }

  const sigValid = verifyEd25519({
    publicKeyBytes,
    signatureBytes,
    messageBytes: Buffer.from(signedPayload, 'utf-8'),
  });
  if (!sigValid) {
    logger.error(
      '[SelfUpdate] manifest Ed25519 signature failed verification. Refusing install.',
    );
    return null;
  }

  return raw;
}

function isSignedReleaseManifestShape(value: unknown): value is SignedReleaseManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'string' &&
    typeof v.sha256 === 'string' &&
    typeof v.signature === 'string' &&
    typeof v.signedAt === 'number'
  );
}

/**
 * Download the pinned tarball via `npm pack` into a tmp dir. Returns
 * the absolute path to the downloaded `.tgz`. Uses `--ignore-scripts`
 * so npm itself does NOT execute any package lifecycle scripts during
 * pack (npm normally runs `prepare` on the *publisher* side; pack on a
 * registry tarball should be inert, but we belt-and-suspenders it).
 *
 * Throws on any failure — caller treats throw as install-blocked.
 */
function npmPackPinnedTarball(version: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  // `npm pack <spec> --pack-destination=<dir> --json` writes the tarball
  // to `<dir>/<sanitized-name>-<version>.tgz` and prints a JSON array
  // describing what was packed. We rely on the deterministic filename
  // instead of parsing the JSON to keep the surface area small.
  const out = execSync(
    `npm pack @synapseia-network/node@${version} --pack-destination=${shellQuote(destDir)} --ignore-scripts --silent`,
    {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  // npm pack prints the filename (basename) on stdout. Compose the abs
  // path from destDir + that basename — robust to any future npm
  // sanitization change.
  const basename = out.split(/\r?\n/).pop()?.trim();
  if (!basename) {
    throw new Error('npm pack produced no output');
  }
  const tarballPath = join(destDir, basename);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack reported "${basename}" but ${tarballPath} does not exist`);
  }
  return tarballPath;
}

/** Defensive shell-quote for paths we pass through `execSync` string
 *  form. We control the value (tmp dir under $HOME) but the rule is
 *  "every external string is hostile" — quoting cheap, audit-friendly. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compute the sha256 of a file on disk and return it as lowercase hex.
 */
function sha256File(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

/**
 * Attempt to self-update the node CLI.
 *
 * Supply-chain hardened (F-node-003, 2026-05-20):
 *   1. Fetch + verify Ed25519-signed manifest from coord `/release/latest`.
 *   2. `npm pack` the pinned version into a tmp dir (no install yet).
 *   3. sha256-verify the on-disk tarball against the signed manifest.
 *   4. `npm install -g <tarball-path> --ignore-scripts` so no `preinstall`
 *      / `postinstall` / `prepare` lifecycle scripts can execute.
 *
 * Fail-closed at every step. A missing `/release/latest` endpoint
 * (older coord deployments) REFUSES the update rather than falling
 * back to unverified `@latest`. The operator follow-up is to add the
 * signed-manifest endpoint to coord.
 *
 * Git-clone and binary installs still require manual intervention.
 */
export async function attemptSelfUpdate(coordinatorUrl: string): Promise<SelfUpdateResult> {
  const installType = detectInstallType();

  switch (installType) {
    case InstallType.NPM_GLOBAL: {
      // ── 1. Fetch + verify signed manifest ──────────────────────────
      const manifest = await fetchSignedReleaseManifest(coordinatorUrl);
      if (!manifest) {
        return {
          success: false,
          installType,
          message:
            'Refusing self-update: coord /release/latest did not return a valid Ed25519-' +
            'signed manifest. Update aborted to avoid unverified supply-chain install. ' +
            'Operator follow-up: ensure coord exposes /release/latest with the signed ' +
            'manifest shape {version, sha256, signature, signedAt} signed by ' +
            'COORDINATOR_PRIVKEY_BASE58. Falling back to `npm install -g @latest` is ' +
            'NOT supported by this version.',
        };
      }

      const tmpDir = join(homedir(), '.synapseia', 'self-update', String(Date.now()));
      let tarballPath: string;
      try {
        // ── 2. npm pack pinned version into tmp dir ─────────────────
        logger.log(`[SelfUpdate] Packing @synapseia-network/node@${manifest.version} (signed manifest verified)...`);
        tarballPath = npmPackPinnedTarball(manifest.version, tmpDir);
      } catch (err) {
        return {
          success: false,
          installType,
          message: `npm pack of pinned version ${manifest.version} failed: ${(err as Error).message}`,
        };
      }

      // ── 3. sha256-verify the downloaded tarball ────────────────────
      let actualSha: string;
      try {
        const stats = require('fs').statSync(tarballPath);
        if (stats.size > TARBALL_MAX_BYTES) {
          return {
            success: false,
            installType,
            message:
              `Packed tarball exceeds ${TARBALL_MAX_BYTES} bytes (got ${stats.size}). Refusing install.`,
          };
        }
        actualSha = sha256File(tarballPath);
      } catch (err) {
        return {
          success: false,
          installType,
          message: `Failed to read packed tarball: ${(err as Error).message}`,
        };
      }
      if (actualSha !== manifest.sha256) {
        logger.error(
          `[SelfUpdate] tarball sha256 mismatch. expected=${manifest.sha256} actual=${actualSha}`,
        );
        return {
          success: false,
          installType,
          message:
            `Tarball sha256 mismatch (expected ${manifest.sha256}, got ${actualSha}). ` +
            `Refusing install — possible registry compromise or stale manifest.`,
        };
      }
      logger.log(`[SelfUpdate] tarball sha256 verified against signed manifest.`);

      // ── 4. npm install -g <tarball> --ignore-scripts ───────────────
      try {
        logger.log('[SelfUpdate] Installing verified tarball with --ignore-scripts...');
        // Target the SAME prefix the running binary was loaded from
        // — otherwise the update lands in a different prefix and the
        // operator's PATH still resolves to the stale binary, kicking
        // off an infinite "update available" loop on every boot.
        //
        // Fallback to the user-owned `~/.synapseia/npm-global` when
        // the running prefix can't be detected (compiled bundle, dev
        // tree, …). The user prefix avoids sudo prompts that would
        // hang a Tauri-spawned CLI without a TTY.
        const runningPrefix = getRunningInstallPrefix();
        const targetPrefix = runningPrefix ?? join(homedir(), '.synapseia', 'npm-global');
        mkdirSync(targetPrefix, { recursive: true });
        logger.log(`[SelfUpdate] target prefix: ${targetPrefix}`);

        execSync(
          `npm install -g ${shellQuote(tarballPath)} --ignore-scripts`,
          {
            encoding: 'utf-8',
            timeout: 120_000,
            stdio: 'pipe',
            env: {
              ...process.env,
              NPM_CONFIG_PREFIX: targetPrefix,
            },
          },
        );
        return {
          success: true,
          installType,
          message: `Updated to v${manifest.version} (signed + sha256-verified, --ignore-scripts). Restarting...`,
        };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (/EACCES|permission denied|operation not permitted/i.test(msg)) {
          return {
            success: false,
            installType,
            message:
              'npm install -g failed with a permission error. ' +
              'The running binary lives in a write-protected prefix (likely ' +
              '/usr/local or /opt/homebrew). Run `sudo npm install -g ' +
              '@synapseia-network/node@latest` manually, OR reinstall under ' +
              'a user-local Node manager (nvm/volta/fnm) to enable ' +
              'sudo-free auto-updates.',
          };
        }
        return {
          success: false,
          installType,
          message: `npm install of verified tarball failed: ${msg}`,
        };
      }
    }

    case InstallType.GIT_CLONE:
      return {
        success: false,
        installType,
        message: 'Git clone detected. Run `git pull && npm run build` manually.',
      };

    case InstallType.BINARY:
      return {
        success: false,
        installType,
        message: 'Binary install detected. Download the latest release from GitHub.',
      };

    default:
      return {
        success: false,
        installType,
        message: 'Unknown install type. Update manually: npm i -g @synapseia-network/node',
      };
  }
}

/**
 * Walk up from `start` looking for a directory containing a `.git/`
 * folder. Returns the path to the directory or null. Used by
 * detectInstallType so it works whether this module ships from
 * src/utils/ (dev) or dist/ (production bundle).
 */
function findGitRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Signal that the current process should be relaunched by its host
 * (the desktop UI or the user's shell loop). We do NOT exec a new
 * child here: when this CLI is spawned by the Tauri desktop UI, the
 * UI already keeps a child-process handle and respawns on exit;
 * trying to spawn a child from inside the doomed process produces
 * a lockfile collision (old process still alive, child sees the
 * lock, bails with "Another Synapseia node is already running from
 * the desktop UI").
 *
 * Exit cleanly and let the orchestrator take over. For shell-spawned
 * runs the user will simply see the process exit and can re-run
 * `synapseia start`; we print an explicit `[SELF_UPDATE_RESTART]`
 * line to stdout before exiting so a human in the shell sees the cue
 * and the desktop UI's log tail picks it up.
 */
/**
 * F-node-013 (P30 reviewer-lesson) — graceful shutdown handles surfaced
 * by the caller so we can flush the telemetry ring buffer and stop the
 * libp2p node BEFORE `process.exit(0)`. Previously this function exited
 * immediately, dropping up to 1000 in-memory telemetry events plus any
 * "update applied" / in-flight error context.
 *
 * Each handle is optional: pre-flight callers (which run BEFORE p2p +
 * telemetry are constructed) pass nothing and behave exactly like the
 * pre-fix call site. Steady-state callers from node-runtime pass both.
 *
 * Mirrors the SIGTERM shutdown sequence in node-runtime.ts: emit a
 * shutdown event, drain the ring with a bounded budget, stop p2p.
 */
export interface RestartShutdownHandles {
  /**
   * Stop the telemetry client and flush its ring + spool head with a
   * bounded budget. Implementations should call `drainAll(timeoutMs)`
   * then `stop()`. Errors are swallowed by `restartProcess`.
   */
  stopTelemetry?: (timeoutMs: number) => Promise<void>;
  /**
   * Stop the libp2p node. Errors are swallowed by `restartProcess`.
   */
  stopP2p?: () => Promise<void>;
}

const SHUTDOWN_BUDGET_MS = 5_000;

export async function restartProcess(
  handles: RestartShutdownHandles = {},
): Promise<never> {
  // Operator-facing banner. The first line is the actionable instruction
  // — keep it loud and unambiguous so a human reading the log tail in the
  // desktop UI does not just see "exited" and assume the node crashed.
  logger.log('');
  logger.log('============================================================');
  logger.log('  UPDATE INSTALLED — RESTART REQUIRED');
  logger.log('  A new version of @synapseia-network/node was downloaded.');
  logger.log('  This process is exiting now. To pick up the new code:');
  logger.log('    - Desktop app: click Start again, or quit the app and');
  logger.log('      reopen it so the new CLI is spawned fresh.');
  logger.log('    - Shell users: re-run `synapseia start`.');
  logger.log('  Wallet, identity, and persisted config are unchanged.');
  logger.log('============================================================');
  logger.log('');
  logger.log('[SelfUpdate] Update applied. Flushing telemetry + stopping p2p before exit.');

  // Bounded graceful shutdown. We split the 5s budget between telemetry
  // and p2p — telemetry first so the "update applied" log line (just
  // emitted via logger.log → tap → ring) reaches the coord before the
  // process dies. Each step is timeout-guarded so a hung handle cannot
  // block the relaunch.
  const half = Math.floor(SHUTDOWN_BUDGET_MS / 2);
  if (handles.stopTelemetry) {
    try {
      await Promise.race([
        handles.stopTelemetry(half),
        new Promise<void>((resolve) => setTimeout(resolve, half + 250)),
      ]);
    } catch {
      /* best effort — don't block relaunch on telemetry */
    }
  }
  if (handles.stopP2p) {
    try {
      await Promise.race([
        handles.stopP2p(),
        new Promise<void>((resolve) => setTimeout(resolve, half)),
      ]);
    } catch {
      /* best effort — don't block relaunch on p2p */
    }
  }

  // Mirror to stdout in case logger output is suppressed by a
  // log-level filter; the desktop UI's log tail watches stdout/stderr.
  // eslint-disable-next-line no-console
  console.log('[SELF_UPDATE_RESTART] Update applied, exiting for relaunch.');
  process.exit(0);
}
