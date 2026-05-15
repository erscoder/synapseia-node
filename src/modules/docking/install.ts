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

  if (env.DISABLE_AUTO_INSTALL_DOCKING === 'true') {
    return {
      installed: false,
      reason: 'disabled by env (DISABLE_AUTO_INSTALL_DOCKING=true)',
    };
  }

  const t0 = Date.now();
  try {
    if (platform === 'darwin') {
      // Verify brew exists before attempting install
      exec('brew --version', { stdio: 'pipe', timeout: 5_000 });
      exec('brew install autodock-vina open-babel', {
        stdio: 'inherit',
        timeout: 300_000,
      });
      return { installed: true, durationMs: Date.now() - t0 };
    }

    if (platform === 'linux') {
      // Try apt-get first (Debian/Ubuntu)
      try {
        exec('apt-get --version', { stdio: 'pipe', timeout: 5_000 });
        exec('sudo apt-get install -y autodock-vina openbabel', {
          stdio: 'inherit',
          timeout: 300_000,
        });
        return { installed: true, durationMs: Date.now() - t0 };
      } catch {
        // apt-get not available — try dnf next
      }

      // Fall back to dnf (RHEL/Fedora)
      try {
        exec('dnf --version', { stdio: 'pipe', timeout: 5_000 });
        exec('sudo dnf install -y autodock-vina openbabel', {
          stdio: 'inherit',
          timeout: 300_000,
        });
        return { installed: true, durationMs: Date.now() - t0 };
      } catch (err) {
        return {
          installed: false,
          reason: `no supported package manager found (tried apt-get + dnf): ${
            (err as Error).message
          }`,
          durationMs: Date.now() - t0,
        };
      }
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
