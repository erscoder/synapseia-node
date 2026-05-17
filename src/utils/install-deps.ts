import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import logger from './logger';
import {
  deleteLoraStackMarker,
  ensureVenv,
  readDilocoModelMarker,
  venvExists,
  venvPip,
  venvPython,
  writeDilocoModelMarker,
  writeLoraStackMarker,
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
  | 'diloco-model'
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
  installedDilocoModel: boolean;
  installedDocking: boolean;
  errors: string[];
}

/** Pinned torch version — must match the previous inline install. */
const TORCH_VERSION = '2.10.0';
/** Minimum Python minor version (3.x). */
const REQUIRED_PYTHON_MINOR = 14;

/**
 * Default DiLoCo foundation model. Matches:
 *   - `diloco_train.py` default (`config.get("modelId", "Qwen/Qwen2.5-7B")`)
 *   - coord-side `DiLoCoController` + `DiLoCoRoundCron` defaults.
 * If/when coord starts pinning per-round model ids, this constant becomes
 * a fallback — install-deps would need a `--diloco-model` CLI flag or
 * env override (`SYNAPSEIA_DILOCO_MODEL`) to track per-pod assignments.
 * Today every DiLoCo round uses Qwen2.5-7B so pinning here is correct.
 */
const DEFAULT_DILOCO_MODEL_ID =
  process.env.SYNAPSEIA_DILOCO_MODEL?.trim() || 'Qwen/Qwen2.5-7B';

/**
 * Minimum cumulative cache size (bytes) considered "model is present".
 * Qwen2.5-7B is ~13 GB across multiple safetensors shards; 500 MB
 * comfortably covers tokenizer + config + at least one shard while
 * still catching the failure mode where only a few KB of metadata
 * downloaded before the network died. A pure config-only snapshot
 * (~1 MB) MUST NOT pass this gate.
 */
const DILOCO_MODEL_MIN_SIZE_BYTES = 500 * 1024 * 1024;

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
 *   6. diloco-model  — pre-download DiLoCo foundation model (Qwen2.5-7B,
 *                      ~13 GB) into the HF cache so runtime DiLoCo WOs
 *                      never hit Hugging Face Hub (Bug 18 v3). Gated on
 *                      the same tier check as lora-stack — only nodes that
 *                      could actually run a DiLoCo WO do the download.
 *                      Writes `~/.synapseia/diloco-model-ok` marker that
 *                      heartbeat reads to advertise `diloco_training`.
 *   7. docking       — install AutoDock Vina + Open Babel (GPU nodes only).
 *                      Function name `installPythonDeps` is historical — this
 *                      phase is non-Python (native binaries via brew/apt/dnf).
 *   8. complete      — final event with status=done|error
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
    installedDilocoModel: false,
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
    // Bug 12 v2: the post-install probe is the AUTHORITATIVE signal
    // for writing the marker. Both branches below (skip when already
    // installed, install fresh) MUST end with a verification probe so
    // the marker only exists when the import truly succeeds for this
    // venv. Each probe captures stdout to extract transformers.__version__
    // for telemetry (purely informational; missing is fine).
    const runVerifyProbe = () => spawnSync(
      venvPython(),
      [
        '-c',
        'import transformers, peft, datasets, safetensors, accelerate; print(transformers.__version__)',
      ],
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    const writeMarkerFromProbe = (probe: ReturnType<typeof runVerifyProbe>) => {
      // Bug 12 v2 (reviewer MED-2): guard on venvExists() — the probe
      // above already used venvPython() so a missing venv would have
      // exit-code-failed before reaching here, but the explicit guard
      // documents the invariant that the marker MUST NEVER exist
      // without the venv it points to.
      if (!venvExists()) return;
      const versionLine = (probe.stdout ?? '').toString().trim().split('\n').pop()?.trim();
      writeLoraStackMarker({
        venvPython: venvPython(),
        transformersVersion: versionLine && versionLine.length > 0 ? versionLine : undefined,
      });
    };
    const loraProbe = runVerifyProbe();
    if (loraProbe.status === 0) {
      // Already-installed path. Write the marker NOW so the next node
      // boot can prime its cache without re-spawning the probe.
      // Without this, an operator who pre-installed deps manually
      // would never get marker coverage until they hit phase 3 install.
      writeMarkerFromProbe(loraProbe);
      emit({ phase: 'lora-stack', status: 'skip', message: 'LoRA training stack already installed' });
    } else {
      emit({ phase: 'lora-stack', status: 'running', message: 'Installing LoRA training stack (~500MB)...' });
      try {
        // Pin transformers floor to 4.43: that release introduced the
        // `dtype` keyword on `from_pretrained` which our DiLoCo /
        // LoRA scripts rely on. transformers 5.x hard-removed the
        // legacy `torch_dtype` kwarg → pods that installed unpinned
        // ended up on 5.8.1 and crashed every DiLoCo accept (Bug 14
        // 2026-05-17). No upper-pin: we want pods to track upstream
        // security fixes, and `dtype` is stable across 4.43→5.x.
        execSync(
          `"${venvPip()}" install "transformers>=4.43" peft datasets safetensors accelerate`,
          { stdio: 'inherit' },
        );
        // POST-install verify is required (not just trusted from
        // pip's exit code): pip can succeed while the install
        // produces a broken stack (torch ABI mismatch,
        // half-extracted wheel on a low-disk pod, etc.). The marker
        // MUST only exist when `import transformers, peft, …`
        // actually succeeds.
        const verify = runVerifyProbe();
        if (verify.status === 0) {
          writeMarkerFromProbe(verify);
          result.installedLoraStack = true;
          emit({ phase: 'lora-stack', status: 'done', message: 'LoRA training stack installed' });
        } else {
          // Install reported success but verification failed —
          // delete any stale marker from a previous boot so the
          // node doesn't keep advertising lora_training based on
          // outdated state, then surface the verify stderr so the
          // operator knows WHICH import broke.
          deleteLoraStackMarker();
          const verifyStderr = (verify.stderr ?? '').toString().trim().split('\n').pop() ?? `exit ${verify.status}`;
          const msg = `LoRA stack install completed but post-install import failed: ${verifyStderr}. Try manually: "${venvPython()}" -c "import transformers, peft, datasets, safetensors, accelerate"`;
          emit({ phase: 'lora-stack', status: 'error', message: msg });
          result.errors.push(msg);
        }
      } catch (err) {
        // pip failed outright — also remove any stale marker so
        // we don't advertise caps based on a previous run.
        deleteLoraStackMarker();
        const msg = `LoRA stack install failed: ${(err as Error).message}. Try manually: "${venvPip()}" install "transformers>=4.43" peft datasets safetensors accelerate`;
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

  // ── Phase 6: diloco-model (pre-download foundation model) ───────────────
  // Bug 18 v3: DiLoCo runtime was crashing mid weight-load because
  // `from_pretrained()` was downloading the 7B model on every WO accept.
  // Pre-download here ONCE so the runtime can use `local_files_only=True`
  // and never hit HF Hub. Gated on the same hardware envelope as the
  // LoRA stack — operators below Tier 1 / no GPU+RAM combo aren't viable
  // DiLoCo runners and shouldn't pay the 13 GB disk cost.
  //
  // Non-blocking on failure: pods that can't download the model still
  // boot and advertise other caps. The heartbeat gates `diloco_training`
  // on the marker so the coord routes DiLoCo elsewhere automatically —
  // strictly better than the pre-fix behaviour where the pod accepted
  // the WO and crashed Python mid-load.
  const dilocoTierOk = hardware.hardwareClass >= 1
    && (hardware.gpuVramGb > 0 || hardware.ramGb >= 16);
  const dilocoOptOut = process.env.INSTALL_DILOCO_MODEL === 'false';

  if (!dilocoTierOk) {
    emit({ phase: 'diloco-model', status: 'skip', message: 'Node tier too low for DiLoCo WOs; skipping model pre-download' });
  } else if (dilocoOptOut) {
    emit({ phase: 'diloco-model', status: 'skip', message: 'INSTALL_DILOCO_MODEL=false; skipping DiLoCo model pre-download' });
  } else if (!venvExists()) {
    // No venv = no huggingface_hub = no download. Don't error — earlier
    // phases already emitted the venv failure; we just skip.
    emit({ phase: 'diloco-model', status: 'skip', message: 'No venv available; DiLoCo model pre-download skipped' });
  } else {
    const existing = readDilocoModelMarker(DEFAULT_DILOCO_MODEL_ID);
    if (existing && existing.sizeBytes >= DILOCO_MODEL_MIN_SIZE_BYTES) {
      const sizeGb = (existing.sizeBytes / (1024 ** 3)).toFixed(2);
      emit({
        phase: 'diloco-model',
        status: 'skip',
        message: `DiLoCo model ${DEFAULT_DILOCO_MODEL_ID} already cached (${sizeGb} GB)`,
      });
    } else {
      const downloadResult = await runDilocoModelDownload(DEFAULT_DILOCO_MODEL_ID, emit);
      if (downloadResult.ok) {
        result.installedDilocoModel = true;
        const sizeGb = (downloadResult.sizeBytes / (1024 ** 3)).toFixed(2);
        emit({
          phase: 'diloco-model',
          status: 'done',
          message: `DiLoCo model ${DEFAULT_DILOCO_MODEL_ID} downloaded (${sizeGb} GB)`,
        });
      } else {
        // Bug 18 v3: FAIL LOUD. Runtime is local-only — without the
        // marker, the diloco_training cap will not be advertised AND
        // any rogue WO that bypassed the gate would fail-fast in
        // _resolve_local_snapshot(). We push to result.errors so the
        // operator sees a clear "DiLoCo unavailable" signal at install
        // time rather than discovering it after the first round.
        // The node remains usable for other caps (LoRA, Vina,
        // inference) — diloco_training is the only cap that depends on
        // this marker.
        const msg = `DiLoCo model pre-download failed: ${downloadResult.reason}. Node will NOT advertise diloco_training. Re-run \`syn install-deps\` after fixing network connectivity (optionally set HF_TOKEN for higher Hub rate limit during install).`;
        emit({ phase: 'diloco-model', status: 'error', message: msg });
        result.errors.push(`diloco-model: ${downloadResult.reason}`);
      }
    }
  }

  // ── Phase 7: docking (Vina + Open Babel) ────────────────────────────────
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

  // ── Phase 8: complete ───────────────────────────────────────────────────
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
 * Pre-download the DiLoCo foundation model into the local Hugging Face
 * cache and persist a marker so heartbeat can gate `diloco_training`.
 *
 * This is the ONLY place where the foundation model is fetched from
 * the Hub. The runtime path (`diloco_train.py`) loads with
 * `local_files_only=True` and fails fast if the cache is missing — so
 * a failed pre-download means the node will NOT advertise
 * `diloco_training` (heartbeat gates on the marker) and the coord
 * routes DiLoCo work elsewhere automatically.
 *
 * Uses `huggingface_hub.snapshot_download` via the venv python rather
 * than the `huggingface-cli` binary — the CLI is an optional extra and
 * may not be on PATH inside the venv, while `snapshot_download` is the
 * canonical function `from_pretrained()` calls internally. Same cache
 * layout, same auth handling, same download semantics.
 *
 * HF_TOKEN is honored at install time only (operator opt-in for higher
 * Hub rate limit during the one-time download). Runtime never reads it.
 * Anonymous download also works but may hit rate limits on a fresh
 * pod — we retry transient errors with exponential backoff.
 *
 * Retry policy: up to `MAX_DOWNLOAD_ATTEMPTS` attempts with backoff.
 * `snapshot_download` itself is idempotent (resumes from partial cache
 * on each attempt), so re-spawning the subprocess is cheap on retry —
 * already-downloaded shards are detected via etag and skipped.
 *
 * @internal exported for testing only — production callers go through
 *           `installPythonDeps`.
 */
export async function runDilocoModelDownload(
  modelId: string,
  emit: (event: InstallDepsEvent) => void,
  spawnFn: typeof spawnSync = spawnSync,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ ok: true; sizeBytes: number; cacheDir: string } | { ok: false; reason: string }> {
  emit({
    phase: 'diloco-model',
    status: 'running',
    message: `Pre-downloading DiLoCo model ${modelId} (~13 GB for Qwen2.5-7B; this is a one-time cost)...`,
  });

  // Inline python: snapshot_download returns the cache snapshot path.
  // Print it on the last stdout line so we can capture it deterministically.
  // We deliberately avoid `huggingface-cli download` because:
  //   1. It's optional (installed only with `huggingface_hub[cli]`)
  //   2. Its stdout format has changed between hf_hub releases
  // `snapshot_download` API is stable since hf_hub 0.14.
  const pyScript = [
    'import os, sys, json',
    'from huggingface_hub import snapshot_download',
    `path = snapshot_download(repo_id=${JSON.stringify(modelId)}, token=os.environ.get("HF_TOKEN") or None)`,
    'print("DILOCO_CACHE_DIR=" + path)',
  ].join('\n');

  const MAX_DOWNLOAD_ATTEMPTS = 3;
  let lastReason = '';
  let lastStdout = '';
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    const result = spawnFn(venvPython(), ['-c', pyScript], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env },
    });

    if (result.status === 0) {
      lastStdout = (result.stdout ?? '').toString();
      break;
    }

    const stderrTail =
      (result.stderr ?? '').toString().trim().split('\n').pop() ?? `exit ${result.status}`;
    lastReason = stderrTail.slice(0, 500);

    if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
      const delayMs = 5_000 * Math.pow(2, attempt - 1); // 5s, 10s
      emit({
        phase: 'diloco-model',
        status: 'running',
        message: `snapshot_download attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS} failed (${lastReason}); retrying in ${delayMs / 1000}s...`,
      });
      // Bug 18 v3 reviewer LOW-1: previously a busy-wait `while (Date.now()
      // < end) {}` pegged a CPU core at 100% for 5s + 10s during retry
      // backoff, starving pip and other co-resident processes. Replaced
      // with an async setTimeout — install-deps is already invoked from
      // an async caller, and `sleepFn` is injectable so specs stay fast
      // by replacing it with a no-op resolver.
      await sleepFn(delayMs);
    }
  }

  if (!lastStdout) {
    return { ok: false, reason: lastReason || 'snapshot_download failed after all retries' };
  }

  // Extract the cache dir from the marker line. snapshot_download
  // prints nothing else to stdout under normal operation, but a chatty
  // tqdm progress bar could appear on stderr — we only parse stdout.
  const match = lastStdout.match(/DILOCO_CACHE_DIR=(.+)$/m);
  if (!match) {
    return { ok: false, reason: `snapshot_download succeeded but cache dir not captured from stdout (got: ${lastStdout.slice(-200)})` };
  }
  const cacheDir = match[1]!.trim();
  if (!existsSync(cacheDir)) {
    return { ok: false, reason: `snapshot_download returned ${cacheDir} but path does not exist` };
  }

  // Sum file sizes under the snapshot dir. HF caches use symlinks to
  // a `blobs/` dir — we follow them via `statSync` (not lstatSync) so
  // the count reflects actual on-disk bytes.
  const sizeBytes = sumDirSize(cacheDir);
  if (sizeBytes < DILOCO_MODEL_MIN_SIZE_BYTES) {
    return {
      ok: false,
      reason: `downloaded cache size ${sizeBytes} bytes < min ${DILOCO_MODEL_MIN_SIZE_BYTES} (download likely incomplete)`,
    };
  }

  const wrote = writeDilocoModelMarker({
    modelId,
    cacheDir,
    downloadedAt: Date.now(),
    sizeBytes,
  });
  if (!wrote) {
    return { ok: false, reason: 'marker write failed (heartbeat will not see the download)' };
  }
  return { ok: true, sizeBytes, cacheDir };
}

/**
 * Recursively sum file sizes under a directory, following symlinks.
 * Used to compute the cache size of a HF model snapshot, where the
 * snapshot directory is full of symlinks into a sibling `blobs/` dir.
 *
 * Defensive: tolerates broken symlinks and unreadable subdirs (returns
 * partial sum rather than throwing). Worst case the result is an
 * under-count, which would just fail the MIN_SIZE_BYTES gate and emit
 * a sane "download incomplete" reason.
 */
function sumDirSize(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p); // follows symlinks
      if (st.isDirectory()) {
        total += sumDirSize(p);
      } else if (st.isFile()) {
        total += st.size;
      }
    } catch {
      // broken symlink / perm error — skip
    }
  }
  return total;
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
