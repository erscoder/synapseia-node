import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
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
  try {
    // npm global: `npm root -g` contains our package
    const npmGlobalRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (existsSync(join(npmGlobalRoot, '@synapseia', 'node', 'package.json'))) {
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
        execSync('npm install -g @synapseia/node@latest', {
          encoding: 'utf-8',
          timeout: 120_000,
          stdio: 'pipe',
        });
        return {
          success: true,
          installType,
          message: 'Updated via npm. Restarting...',
        };
      } catch (err) {
        return {
          success: false,
          installType,
          message: `npm update failed: ${(err as Error).message}`,
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
        message: 'Unknown install type. Update manually: npm i -g @synapseia/node',
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
 * Restart the current process by re-executing with the same args.
 * Only call after a successful self-update.
 */
export function restartProcess(): never {
  const args = process.argv.slice(1);
  logger.log('[SelfUpdate] Restarting process...');
  try {
    execFileSync(process.argv[0], args, {
      stdio: 'inherit',
      env: process.env,
    });
  } catch {
    // The new process exited - we should too
  }
  process.exit(0);
}
