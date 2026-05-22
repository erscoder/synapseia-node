import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { valid } from 'semver';
import logger from './logger';

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

/** Defensive shell-quote for the version spec we pass through `execSync`
 *  string form. The version comes from the npm dist-tags `latest` (and is
 *  semver-validated by the caller), but the rule is "every external string
 *  is hostile" — quoting is cheap and audit-friendly. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Attempt to self-update the node CLI.
 *
 * Trust model (2026-05-22 — DELIBERATE removal of the coord-signed-manifest
 * gate). The npm registry's `latest` dist-tag is the SOLE source of truth
 * for what to install: the npm publish account is the de-facto release
 * authority and CI is the only publisher. The update DECISION (is there a
 * newer version?) is made upstream by `preflightVersionCheck`
 * (update-checker.ts) reading the npm dist-tags; this function is handed the
 * already-resolved target version and installs it directly:
 *
 *   npm install -g @synapseia-network/node@<targetVersion> --ignore-scripts
 *
 * `--ignore-scripts` is the residual supply-chain mitigation — it blocks
 * `preinstall` / `postinstall` / `prepare` lifecycle scripts from running
 * during install. The exact target version is PINNED (never the floating
 * `@latest`), so the install is reproducible and cannot be moved out from
 * under us by a registry change between the check and the install.
 *
 * Fail-closed: any failure returns `{success:false}` and the caller keeps
 * the node on its current version. Only NPM_GLOBAL installs self-update;
 * git-clone and binary installs still require manual intervention.
 */
export async function attemptSelfUpdate(targetVersion: string): Promise<SelfUpdateResult> {
  const installType = detectInstallType();

  switch (installType) {
    case InstallType.NPM_GLOBAL: {
      if (!valid(targetVersion)) {
        return {
          success: false,
          installType,
          message: `Refusing self-update: target version "${targetVersion}" is not valid semver.`,
        };
      }

      try {
        logger.log(
          `[SelfUpdate] Installing @synapseia-network/node@${targetVersion} from npm with --ignore-scripts...`,
        );
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

        // PINNED version (never floating `@latest`): the target was resolved
        // from npm dist-tags upstream; pinning makes the install reproducible
        // and immune to a registry change between the check and the install.
        execSync(
          `npm install -g @synapseia-network/node@${shellQuote(targetVersion)} --ignore-scripts`,
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
          message: `Updated to v${targetVersion} (npm latest, --ignore-scripts). Restarting...`,
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
              `@synapseia-network/node@${targetVersion}\` manually, OR reinstall under ` +
              'a user-local Node manager (nvm/volta/fnm) to enable ' +
              'sudo-free auto-updates.',
          };
        }
        return {
          success: false,
          installType,
          message: `npm install -g @synapseia-network/node@${targetVersion} failed: ${msg}`,
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
  /**
   * Release the single-instance lock file synchronously, called right
   * before the detached respawn so the freshly-spawned `syn start`
   * child does not see the dying parent's lock and bail with "Another
   * Synapseia node is already running". No-op when `respawn` is false.
   * Errors are swallowed by `restartProcess`.
   */
  releaseLock?: () => void;
  /**
   * When true, AND the process is NOT supervised by the desktop UI
   * (`SYNAPSEIA_LAUNCH_SOURCE !== 'ui'`), spawn a detached replacement
   * `syn start` before exiting. Required for pods / shell runs that have
   * no host supervisor — a plain `process.exit(0)` would leave them DOWN.
   *
   * Desktop-UI runs keep `respawn` effectively disabled at runtime: the
   * UI already keeps a child-process handle and respawns on exit, so a
   * self-spawned child would collide on the lock file (see the
   * `restartProcess` docblock). The UI gate is enforced inside
   * `restartProcess`, not by the caller, so a mis-set flag cannot break
   * the UI path.
   */
  respawn?: boolean;
}

const SHUTDOWN_BUDGET_MS = 5_000;

/**
 * Spawn a detached replacement `syn start` that survives the parent's
 * exit. Mirrors `.devnet/pod-update-restart.sh`:
 *   - re-runs the SAME argv (the `start` subcommand + any flags the
 *     operator passed, e.g. `--set-name`, `--inference`);
 *   - inherits the full env, so `SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE`
 *     (mounted by the pod / set by `provision-newpod.sh`) is preserved
 *     and the child unlocks the keystore non-interactively;
 *   - `detached: true` + `unref()` so the child is reparented to init
 *     and keeps running after this process dies;
 *   - `stdio: 'inherit'` so the new process writes to the same log file
 *     the pod redirects (`>/var/log/syn.log 2>&1`).
 *
 * Returns true if the child was spawned, false on any failure (the
 * caller then falls back to a plain exit — fail-closed, never throw).
 */
export function respawnDetached(): boolean {
  try {
    // process.argv === [nodeBinary, scriptPath, ...userArgs]. We re-exec
    // the SAME node binary against the SAME bootstrap script + args so
    // the relaunch is byte-identical to how the pod / shell invoked us,
    // just running the freshly-installed code on disk.
    const [, scriptPath, ...userArgs] = process.argv;
    if (!scriptPath) return false;
    const child = spawn(process.execPath, [scriptPath, ...userArgs], {
      detached: true,
      stdio: 'inherit',
      env: process.env,
    });
    child.unref();
    return true;
  } catch (err) {
    logger.error(`[SelfUpdate] detached respawn failed: ${(err as Error).message}`);
    return false;
  }
}

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
  //
  // F-node-ui-004 (P10): the Tauri UI now requires a canonical, anchored
  // marker `[SELF_UPDATE_RESTART] nonce=<hex>  v<semver>  pid=<digits>`
  // where `nonce` matches `SYNAPSEIA_SELF_UPDATE_NONCE` injected at
  // spawn time. Only the legitimate child process knows the nonce, so a
  // malicious WO / KG ingest / web-search result whose stdout merely
  // contains the literal substring can no longer trigger a respawn.
  //
  // Shell-invoked runs (no UI) have no nonce env var — we emit the
  // marker with an empty `nonce=` value, which the UI parser
  // (`parse_self_update_cue_with_nonce` with empty expected nonce)
  // rejects. That is intentional: standalone-shell users were never
  // auto-respawned anyway; they read the operator banner above and
  // re-run `synapseia start` themselves.
  const nonce = process.env.SYNAPSEIA_SELF_UPDATE_NONCE ?? '';
  const version = readOwnVersion();
  const pid = process.pid;
  // eslint-disable-next-line no-console
  console.log(`[SELF_UPDATE_RESTART] nonce=${nonce} v${version} pid=${pid}`);

  // Detached self-respawn for unsupervised runs (pods / shell). The
  // desktop UI is excluded: it keeps its own child-process handle and
  // respawns on exit, so a self-spawned child would collide on the lock
  // file. We gate on the launch source here (not the caller) so a
  // mis-set `respawn` flag can never break the UI path.
  const uiSupervised = process.env.SYNAPSEIA_LAUNCH_SOURCE === 'ui';
  if (handles.respawn && !uiSupervised) {
    // Drop the lock FIRST so the child's single-instance check passes.
    if (handles.releaseLock) {
      try { handles.releaseLock(); } catch { /* best effort */ }
    }
    const spawned = respawnDetached();
    logger.log(
      spawned
        ? '[SelfUpdate] spawned detached replacement process — exiting parent.'
        : '[SelfUpdate] detached respawn unavailable — exiting; host must relaunch.',
    );
  }
  process.exit(0);
}

/**
 * Read this package's own version from the nearest `package.json`. Used
 * by `restartProcess` to embed the version into the canonical
 * `[SELF_UPDATE_RESTART]` marker so the desktop UI can log which build
 * just exited (helps diagnose stuck-on-old-version reports). Falls back
 * to `"0.0.0"` if the lookup fails — the marker still validates as
 * semver-shaped and the UI just sees an unknown version.
 */
function readOwnVersion(): string {
  try {
    const pkgPath = findOwnPackageJson(dirname(__filename));
    if (!pkgPath) return '0.0.0';
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && valid(parsed.version)) {
      return parsed.version;
    }
  } catch { /* fall through */ }
  return '0.0.0';
}

/**
 * Walk up from `start` looking for a `package.json` that names this
 * package. Bounded depth so we never wander outside the install tree.
 */
function findOwnPackageJson(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const text = readFileSync(candidate, 'utf-8');
        if (text.includes('"@synapseia-network/node"')) {
          return candidate;
        }
      } catch { /* ignore unreadable */ }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
