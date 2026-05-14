import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
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
 * Attempt to self-update the node CLI.
 * Only npm global installs can be updated automatically.
 * Git clone and binary installs require manual intervention.
 */
export function attemptSelfUpdate(): SelfUpdateResult {
  const installType = detectInstallType();

  switch (installType) {
    case InstallType.NPM_GLOBAL: {
      try {
        logger.log('[SelfUpdate] Updating via npm...');
        // Force the install into a user-owned prefix
        // (`~/.synapseia/npm-global`) so `npm install -g` never needs
        // sudo. Default global prefixes such as `/usr/local/lib/node_modules`
        // require root on most machines; a Tauri-spawned CLI has no TTY,
        // so a sudo prompt would hang forever. The Tauri Rust resolver
        // (`find_synapseia_node`) has a sibling check for this path.
        const userPrefix = join(homedir(), '.synapseia', 'npm-global');
        mkdirSync(userPrefix, { recursive: true });

        execSync('npm install -g @synapseia-network/node@latest', {
          encoding: 'utf-8',
          timeout: 120_000,
          stdio: 'pipe',
          env: {
            ...process.env,
            NPM_CONFIG_PREFIX: userPrefix,
          },
        });
        return {
          success: true,
          installType,
          message: 'Updated via npm. Restarting...',
        };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (/EACCES|permission denied|operation not permitted/i.test(msg)) {
          return {
            success: false,
            installType,
            message:
              'npm install -g failed with a permission error. ' +
              'Run `npm install -g @synapseia-network/node` manually, ' +
              'or migrate to a user-local Node manager (nvm/volta/fnm) ' +
              'to avoid sudo prompts.',
          };
        }
        return {
          success: false,
          installType,
          message: `npm update failed: ${msg}`,
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
export function restartProcess(): never {
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
  logger.log('[SelfUpdate] Update applied. Exiting so the host can relaunch with the new code.');
  // Mirror to stdout in case logger output is suppressed by a
  // log-level filter; the desktop UI's log tail watches stdout/stderr.
  // eslint-disable-next-line no-console
  console.log('[SELF_UPDATE_RESTART] Update applied, exiting for relaunch.');
  process.exit(0);
}
