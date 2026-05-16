import { existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import logger from './logger';

/**
 * Cross-platform Python venv helper.
 *
 * PEP 668 ("externally-managed-environment") rejects system-wide `pip3
 * install` on Homebrew Python, Debian/Ubuntu Python 3.11+, and Windows
 * Store Python. `--user` is also blocked. `--break-system-packages` works
 * but is unsafe. A venv is the only respectable cross-platform fix.
 *
 * Single venv per host at `~/.synapseia/venv/` (or
 * `%USERPROFILE%\.synapseia\venv\` on Windows). All Python deps install
 * there. All Python subprocess spawns use the venv's interpreter directly.
 */

export const VENV_DIR = process.env.SYNAPSEIA_HOME
  ? join(process.env.SYNAPSEIA_HOME, 'venv')
  : join(homedir(), '.synapseia', 'venv');

/** Path to the venv's python interpreter (cross-platform). */
export function venvPython(): string {
  return process.platform === 'win32'
    ? join(VENV_DIR, 'Scripts', 'python.exe')
    : join(VENV_DIR, 'bin', 'python');
}

/** Path to the venv's pip executable (cross-platform). */
export function venvPip(): string {
  return process.platform === 'win32'
    ? join(VENV_DIR, 'Scripts', 'pip.exe')
    : join(VENV_DIR, 'bin', 'pip');
}

/** True if the venv exists AND its python is invokable. */
export function venvExists(): boolean {
  if (!existsSync(venvPython())) return false;
  const probe = spawnSync(venvPython(), ['--version'], { stdio: 'pipe' });
  return probe.status === 0 && !probe.error;
}

/**
 * Resolve the python interpreter to use for ALL subprocess spawns
 * (train_lora.py, eval_lora.py, diloco_train.py, train_micro.py,
 * heartbeat probes, hardware probes). Venv wins when present;
 * falls back to system python3 (or `python` on Windows) when not.
 *
 * Returns the absolute path or the system binary name as a single
 * string — caller passes it as the first arg to spawn/spawnSync.
 */
export function resolvePython(): string {
  if (venvExists()) return venvPython();
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Create the venv at VENV_DIR if it doesn't exist. Returns true on
 * success or when it already exists. Non-throwing: returns false on
 * any failure (caller logs + decides to continue without LoRA caps).
 */
export function ensureVenv(): boolean {
  if (venvExists()) return true;
  mkdirSync(dirname(VENV_DIR), { recursive: true });
  // Try python3 first, then python (Windows often lacks python3 alias).
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const py of candidates) {
    const result = spawnSync(py, ['-m', 'venv', VENV_DIR], { stdio: 'pipe' });
    if (result.status === 0 && !result.error) {
      logger.log(`[python-venv] created venv at ${VENV_DIR} using ${py}`);
      return true;
    }
  }
  return false;
}
