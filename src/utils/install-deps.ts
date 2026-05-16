import { execSync, spawnSync } from 'child_process';
import * as os from 'os';
import logger from './logger';
import {
  ensureVenv,
  venvExists,
  venvPip,
  venvPython,
} from './python-venv';
import type { Hardware } from '../modules/hardware/hardware';

/**
 * Cross-platform Python dependency installer for the node runtime.
 *
 * Moves the install logic that historically lived inline in `syn start`
 * (cli/index.ts torch + LoRA + bitsandbytes blocks) into a single reusable
 * helper. Two consumers:
 *
 *   1. `syn install-deps` CLI subcommand — invoked by the desktop UI
 *      during its loading screen so deps are ready before the wallet
 *      unlock screen appears.
 *   2. `syn start` — still calls it as a no-op safety net. The helper is
 *      fully idempotent: each phase probes "already installed" first and
 *      emits `status: 'skip'` instead of re-running.
 *
 * Event contract is shared with the Tauri command + frontend loading
 * screen. See InstallDepsEvent below.
 */

export type InstallDepsPhase =
  | 'venv'
  | 'torch'
  | 'lora-stack'
  | 'cuda-probe'
  | 'bitsandbytes'
  | 'docking'
  | 'complete'
  | 'skipped';

export type InstallDepsStatus = 'running' | 'done' | 'error' | 'skip';

export interface InstallDepsEvent {
  phase: InstallDepsPhase;
  status: InstallDepsStatus;
  message: string;
}

export interface InstallDepsOptions {
  /** Hardware snapshot from hardwareService.detect(). Used for tier gate. */
  hardware: Hardware;
  /**
   * Stream phase + message lines to this callback. The CLI `install-deps`
   * subcommand passes a stdout-writer that prints `[INSTALL_PROGRESS]` JSON
   * lines for the Tauri parent to parse. The `start` action passes a no-op
   * (existing behavior is to log inline anyway).
   */
  onProgress?: (event: InstallDepsEvent) => void;
}

export interface InstallDepsResult {
  success: boolean;
  installedTorch: boolean;
  installedLoraStack: boolean;
  installedBitsAndBytes: boolean;
  installedDocking: boolean;
  errors: string[];
}

/** Pinned torch version — must match the previous inline install. */
const TORCH_VERSION = '2.10.0';
/** Minimum Python minor version (3.x). */
const REQUIRED_PYTHON_MINOR = 14;

/**
 * Run a phased install of Python deps for the node runtime. Idempotent:
 * every phase checks "already installed" first and emits `status: 'skip'`
 * instead of re-running. Safe to call from `syn start` on every boot.
 *
 * Phases (in order):
 *   1. venv          — create ~/.synapseia/venv if absent
 *   2. torch         — pip install torch CPU wheel (system-wide check first)
 *   3. lora-stack    — pip install transformers + peft + datasets + safetensors + accelerate
 *                      (only on Tier 1+ nodes with enough RAM/VRAM)
 *   4. cuda-probe    — probe torch.cuda.is_available()
 *   5. bitsandbytes  — pip install bitsandbytes (only when CUDA present)
 *   6. docking       — install AutoDock Vina + Open Babel (GPU nodes only).
 *                      Function name `installPythonDeps` is historical — this
 *                      phase is non-Python (native binaries via brew/apt/dnf).
 *   7. complete      — final event with status=done|error
 */
export async function installPythonDeps(
  options: InstallDepsOptions,
): Promise<InstallDepsResult> {
  const { hardware, onProgress } = options;
  const emit = (event: InstallDepsEvent) => {
    onProgress?.(event);
  };

  const result: InstallDepsResult = {
    success: true,
    installedTorch: false,
    installedLoraStack: false,
    installedBitsAndBytes: false,
    installedDocking: false,
    errors: [],
  };

  // ── Pre-flight: python3 must exist on PATH ──────────────────────────────
  const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!hasPython) {
    // Try to bootstrap python3 ourselves (mirror the previous inline flow).
    // Non-interactive: only attempt when the OS provides a package manager
    // we can call without user input. If the install fails or the platform
    // is unsupported, we emit a `skipped` complete and bail.
    const platOk = bootstrapPython(REQUIRED_PYTHON_MINOR);
    if (!platOk) {
      emit({
        phase: 'complete',
        status: 'skip',
        message: 'python3 not available and could not be installed automatically; node will run without training caps',
      });
      return result;
    }
  }

  // ── Phase 1: venv ───────────────────────────────────────────────────────
  if (venvExists()) {
    emit({ phase: 'venv', status: 'skip', message: 'Python venv already present at ~/.synapseia/venv' });
  } else {
    emit({ phase: 'venv', status: 'running', message: 'Creating Python venv at ~/.synapseia/venv...' });
    const ok = ensureVenv();
    if (!ok) {
      const msg = 'Could not create Python venv; node will run without training caps. Manual fix: python3 -m venv ~/.synapseia/venv';
      emit({ phase: 'venv', status: 'error', message: msg });
      emit({ phase: 'complete', status: 'error', message: msg });
      result.success = false;
      result.errors.push(msg);
      return result;
    }
    emit({ phase: 'venv', status: 'done', message: 'Python venv created' });
  }

  // ── Phase 2: torch ──────────────────────────────────────────────────────
  // Probe the venv interpreter (where the install lands).
  const torchProbe = spawnSync(
    venvPython(),
    ['-c', `import torch; assert torch.__version__ == '${TORCH_VERSION}', torch.__version__`],
    { stdio: 'pipe' },
  );
  if (torchProbe.status === 0) {
    emit({ phase: 'torch', status: 'skip', message: `PyTorch ${TORCH_VERSION} already installed` });
  } else {
    emit({ phase: 'torch', status: 'running', message: `Installing PyTorch ${TORCH_VERSION} (CPU wheel, ~200MB)...` });
    try {
      execSync(
        `"${venvPip()}" install torch==${TORCH_VERSION} --index-url https://download.pytorch.org/whl/cpu`,
        { stdio: 'inherit' },
      );
      result.installedTorch = true;
      emit({ phase: 'torch', status: 'done', message: `PyTorch ${TORCH_VERSION} installed` });
    } catch (err) {
      const msg = `PyTorch install failed: ${(err as Error).message}. Try manually: "${venvPip()}" install torch==${TORCH_VERSION} --index-url https://download.pytorch.org/whl/cpu`;
      emit({ phase: 'torch', status: 'error', message: msg });
      result.errors.push(msg);
      // Continue — LoRA install will likely fail too, but we let the next
      // phase decide rather than aborting the whole flow here.
    }
  }

  // ── Phase 3: lora-stack ─────────────────────────────────────────────────
  // Tier gate: only install on Tier 1+ nodes with enough RAM/VRAM to run a
  // PubMedBERT-class model. Tier 0 / underpowered nodes skip to keep their
  // footprint small. Operators can opt out via INSTALL_LORA=false.
  const loraTierOk = hardware.hardwareClass >= 1
    && (hardware.gpuVramGb > 0 || hardware.ramGb >= 16);
  const loraOptOut = process.env.INSTALL_LORA === 'false';

  if (!loraTierOk) {
    emit({ phase: 'lora-stack', status: 'skip', message: 'Node tier too low for LoRA WOs; skipping LoRA stack' });
  } else if (loraOptOut) {
    emit({ phase: 'lora-stack', status: 'skip', message: 'INSTALL_LORA=false; skipping LoRA stack' });
  } else {
    const loraProbe = spawnSync(
      venvPython(),
      ['-c', 'import transformers, peft, datasets, safetensors, accelerate'],
      { stdio: 'pipe' },
    );
    if (loraProbe.status === 0) {
      emit({ phase: 'lora-stack', status: 'skip', message: 'LoRA training stack already installed' });
    } else {
      emit({ phase: 'lora-stack', status: 'running', message: 'Installing LoRA training stack (~500MB)...' });
      try {
        execSync(
          `"${venvPip()}" install transformers peft datasets safetensors accelerate`,
          { stdio: 'inherit' },
        );
        result.installedLoraStack = true;
        emit({ phase: 'lora-stack', status: 'done', message: 'LoRA training stack installed' });
      } catch (err) {
        const msg = `LoRA stack install failed: ${(err as Error).message}. Try manually: "${venvPip()}" install transformers peft datasets safetensors accelerate`;
        emit({ phase: 'lora-stack', status: 'error', message: msg });
        result.errors.push(msg);
      }
    }
  }

  // ── Phase 4: cuda-probe ─────────────────────────────────────────────────
  // Probe AFTER LoRA install so torch is importable. Non-fatal — CPU-only
  // nodes simply skip phase 5.
  let cudaAvailable = false;
  const cudaProbe = spawnSync(
    venvPython(),
    ['-c', 'import torch; assert torch.cuda.is_available()'],
    { stdio: 'pipe' },
  );
  if (cudaProbe.status === 0 && !cudaProbe.error) {
    cudaAvailable = true;
    emit({ phase: 'cuda-probe', status: 'done', message: 'CUDA available' });
  } else {
    emit({ phase: 'cuda-probe', status: 'skip', message: 'CUDA not available (CPU-only node)' });
  }

  // ── Phase 5: bitsandbytes ───────────────────────────────────────────────
  // CUDA-only, needed by DiLoCo full mode for 4-bit quantization.
  if (cudaAvailable) {
    const bnbProbe = spawnSync(
      venvPython(),
      ['-c', 'import bitsandbytes'],
      { stdio: 'pipe' },
    );
    if (bnbProbe.status === 0) {
      emit({ phase: 'bitsandbytes', status: 'skip', message: 'bitsandbytes already installed' });
    } else {
      emit({ phase: 'bitsandbytes', status: 'running', message: 'Installing bitsandbytes for DiLoCo full mode...' });
      try {
        execSync(`"${venvPip()}" install bitsandbytes`, { stdio: 'inherit' });
        result.installedBitsAndBytes = true;
        emit({ phase: 'bitsandbytes', status: 'done', message: 'bitsandbytes installed' });
      } catch (err) {
        const msg = `bitsandbytes install failed: ${(err as Error).message}. DiLoCo full mode requires it for 4-bit quantization. Try: "${venvPip()}" install bitsandbytes`;
        emit({ phase: 'bitsandbytes', status: 'error', message: msg });
        result.errors.push(msg);
      }
    }
  }

  // ── Phase 6: docking (Vina + Open Babel) ────────────────────────────────
  // GPU-only: mirrors the heartbeat capability gate (gpuVramGb > 0 produces
  // gpu_training / gpu_inference caps, which is what makes a node eligible
  // for docking dispatch). Non-GPU nodes skip — they would never be
  // selected for docking WOs anyway.
  if (hardware.gpuVramGb > 0) {
    try {
      const { isVinaAvailable } = await import('../modules/docking/index.js');
      const vinaPresent = await isVinaAvailable().catch(() => false);
      if (vinaPresent) {
        emit({ phase: 'docking', status: 'skip', message: 'Vina already installed' });
      } else {
        emit({ phase: 'docking', status: 'running', message: 'Installing AutoDock Vina + Open Babel...' });
        const { installDockingDeps } = await import('../modules/docking/install.js');
        const dockingResult = await installDockingDeps();
        if (dockingResult.installed) {
          result.installedDocking = true;
          emit({
            phase: 'docking',
            status: 'done',
            message: `installed in ${dockingResult.durationMs ?? 0}ms`,
          });
        } else {
          const reason = dockingResult.reason ?? 'unknown reason';
          emit({ phase: 'docking', status: 'error', message: reason });
          result.errors.push(`docking: ${reason}`);
        }
      }
    } catch (err) {
      const msg = `Docking install threw: ${(err as Error).message}`;
      emit({ phase: 'docking', status: 'error', message: msg });
      result.errors.push(msg);
    }
  } else {
    emit({ phase: 'docking', status: 'skip', message: 'No GPU detected — docking install skipped' });
  }

  // ── Phase 7: complete ───────────────────────────────────────────────────
  if (result.errors.length === 0) {
    emit({ phase: 'complete', status: 'done', message: 'All Python deps ready' });
  } else {
    result.success = false;
    emit({
      phase: 'complete',
      status: 'error',
      message: `Install completed with ${result.errors.length} error(s); see prior phase events`,
    });
  }
  return result;
}

/**
 * Best-effort install of python3 on hosts that don't have it. Mirrors the
 * inline flow that previously lived in `syn start` (Homebrew on darwin,
 * apt-get / dnf / pacman on Linux). Returns true when python3 is available
 * after the attempt, false otherwise.
 *
 * NOTE: this path uses `sudo` on Linux which will hang on a non-TTY. The
 * Tauri command spawns this CLI non-interactively, so on Linux without
 * passwordless sudo we expect this to fail and the helper to fall through
 * to the `skipped` complete event. That's acceptable: the desktop installer
 * is targeted at macOS/Windows where Python comes via Homebrew / bundled
 * Python and sudo isn't needed.
 */
function bootstrapPython(minMinor: number): boolean {
  const plat = os.platform();
  try {
    if (plat === 'darwin') {
      const hasBrew = spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
      if (!hasBrew) return false;
      const hasPyenv = spawnSync('pyenv', ['--version'], { stdio: 'ignore' }).status === 0;
      if (hasPyenv) {
        execSync(`pyenv install 3.${minMinor} --skip-existing`, { stdio: 'pipe' });
        execSync(`pyenv global 3.${minMinor}`, { stdio: 'pipe' });
      } else {
        try {
          execSync(`brew install python@3.${minMinor}`, { stdio: 'pipe' });
          execSync(`brew link --force python@3.${minMinor}`, { stdio: 'pipe' });
        } catch {
          execSync('brew install python3', { stdio: 'pipe' });
        }
      }
    } else if (plat === 'linux') {
      const hasApt = spawnSync('apt-get', ['--version'], { stdio: 'ignore' }).status === 0;
      const hasDnf = spawnSync('dnf', ['--version'], { stdio: 'ignore' }).status === 0;
      if (hasApt) {
        execSync('sudo -n apt-get install -y python3 python3-venv python3-pip', { stdio: 'pipe' });
      } else if (hasDnf) {
        execSync(`sudo -n dnf install -y python3 python3-pip`, { stdio: 'pipe' });
      } else {
        execSync('sudo -n pacman -S --noconfirm python python-pip', { stdio: 'pipe' });
      }
    } else {
      return false;
    }
    return spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch (err) {
    logger.warn(`[install-deps] python3 bootstrap failed: ${(err as Error).message}`);
    return false;
  }
}
