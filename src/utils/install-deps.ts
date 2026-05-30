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
 *
 * ── PyTorch wheel selection (Slice 16 — Bug DiLoCo OOM root cause) ──────
 *
 * Historically this file HARDCODED `--index-url https://download.pytorch.org/whl/cpu`,
 * which installed CPU-only torch wheels on EVERY platform — including
 * NVIDIA Linux pods (RunPod A40, etc.). Effect on DiLoCo:
 *
 *   - `torch.cuda.is_available()` returned `False` on real NVIDIA hardware
 *     because the installed torch wheel had no CUDA bindings.
 *   - `diloco_train.py` gates its 4-bit BitsAndBytesConfig load on
 *     `device == "cuda"`. With CUDA flagged unavailable, it fell back to
 *     fp32, which needs ~28 GB just for Qwen2.5-7B weights and ~47 GB
 *     peak during from_pretrained — over the pod cgroup limit (46.6 GB)
 *     → OOM kill mid-load.
 *   - `bitsandbytes` install was also skipped because Phase 5 gates on
 *     `cudaAvailable` (derived from the same broken torch probe).
 *
 * Manual verified-working fix on a live A40 pod (2026-05-17):
 *   pip install torch==2.5.1 --index-url \
 *     https://download.pytorch.org/whl/cu121 --force-reinstall
 *   → torch.cuda.is_available() = True, A40 detected, 4-bit path live.
 *
 * `pickTorchWheel()` now probes for NVIDIA hardware BEFORE deciding
 * which wheel to install. macOS gets the default wheel (MPS-enabled
 * via Apple Silicon). NVIDIA Linux/Windows get the cu128 wheel (the
 * version + flavor are Python-version-aware via `selectTorchSpec` — see
 * the matrix below; cu121 / cu124 are no longer used for any supported
 * range). Everything else falls back to the cpu wheel. Phase 5
 * bitsandbytes is now gated on the wheel choice, not the post-install
 * torch probe, so an installed-but-broken torch can't suppress bnb
 * either.
 *
 * ── PyPI drift + Python 3.14 (cp314) fix (2026-05-30) ─────────────────
 *
 * The torch 2.6.0 / cu124 pin (below) AGED OUT of PyPI: the default
 * index now only serves torch {2.9.0, 2.9.1, 2.10.0, 2.11.0, 2.12.0}
 * and the cu124 NVIDIA index stops at 2.6.0. Worse, a node whose venv is
 * Python 3.14 (cp314) has NO 2.6.0 wheel ANYWHERE (2.6.0 shipped no
 * cp314 wheel), so the old `bestEffort` 3.14 path 404'd on every install
 * and the node booted WITHOUT torch — losing pytorch/DiLoCo training
 * caps. Confirmed live on node-kike (venv Python 3.14.5):
 *   ERROR: Could not find a version that satisfies the requirement
 *   torch==2.6.0 (from versions: 2.9.0, 2.9.1, 2.10.0, 2.11.0, 2.12.0)
 *
 * Fix: bump the pin to torch 2.9.1 (oldest stable in the still-served
 * set → least bleeding-edge) and move the NVIDIA index cu124 → cu128.
 * 2.9.1 has REAL wheels for EVERY (OS, Python) combo in the matrix —
 * crucially including cp314 (the headline fix), so 3.14 is no longer
 * best-effort:
 *   - default / MPS index (macOS arm64): cp310-cp314 all present at
 *     2.9.1 (incl. torch-2.9.1-cp314-cp314-macosx_11_0_arm64.whl).
 *   - cpu index: cp310-cp314 present at 2.9.1.
 *   - cu128 NVIDIA index (GPU pods, RunPod linux): cp310-cp314 present
 *     at 2.9.1 (incl. torch-2.9.1+cu128-cp314-cp314-manylinux_2_28_
 *     x86_64.whl + aarch64). cu124 has NEITHER 2.9.1 NOR any cp314 wheel,
 *     hence the index move. cu126/cu129 also carry 2.9.1 cp314 — cu128 is
 *     chosen as the modern default (CUDA 12.8).
 * `bestEffort` is retained ONLY for Python ≥ 3.15 (genuinely unknown
 * future interpreters) so a missing wheel there stays a non-fatal skip.
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

/**
 * PyTorch version + NVIDIA CUDA wheel index, keyed on the venv Python
 * minor version (the `3.x` in `3.13`). EMPIRICALLY VERIFIED matrix —
 * see `selectTorchSpec` below.
 *
 * ── Why this is Python-version-aware (2026-05-22, updated 2026-05-30) ──
 *
 * The original code returned `torch==2.5.1` + the `cu121` NVIDIA index
 * for every interpreter ≤ 3.12. That broke LoRA training: `transformers`
 * / `peft` refuse `torch.load` on torch < 2.6 (CVE mitigation — they
 * "now require users to upgrade torch to at least v2.6"). The 2026-05-22
 * fix moved the whole supported range to `torch==2.6.0` / `cu124`.
 *
 * That 2.6.0 / cu124 pin then AGED OUT of PyPI (2026-05-30): the default
 * index dropped everything below 2.9.0, and cu124 never carried a cp314
 * wheel at all — so Python-3.14 nodes (e.g. node-kike) 404'd on install
 * and booted without torch. The current pin is `torch==2.9.1` / `cu128`,
 * which has REAL wheels for the full matrix incl. cp314 (see the
 * "PyPI drift + Python 3.14" block above for the live wheel inventory).
 *
 * Verified wheel availability (download.pytorch.org/whl + PyPI, 2026-05-30):
 *   - default / MPS + cpu index: torch 2.9.1 for cp310-cp314 (covers the
 *     macOS / CPU path INCLUDING cp314 — the node-kike fix).
 *   - cu128 NVIDIA index: torch 2.9.1 for cp310-cp314 (manylinux_2_28
 *     x86_64 + aarch64, win_amd64). This is the GPU-pod path.
 *   - cu124 (old index) has NEITHER 2.9.1 NOR any cp314 wheel — that is
 *     exactly why the index moved cu124 → cu128.
 *
 * ── Version / NVIDIA-index matrix (empirically verified 2026-05-30) ───
 *
 *   Python minor | torch  | NVIDIA index | status
 *   ────────────────────────────────────────────────────────────────────
 *   10/11/12/13  | 2.9.1  | cu128        | Wheels present on cu128 + default
 *                |        |              | for the full cp tag range.
 *   14 (cp314)   | 2.9.1  | cu128        | NOW A REAL WHEEL (no longer
 *                |        |              | best-effort). 2.9.1 ships
 *                |        |              | cp314 on default/cpu AND cu128.
 *                |        |              | This is the node-kike fix.
 *   ≥ 15         | 2.9.1  | cu128        | BEST-EFFORT only — no pinned wheel
 *                |        |  (attempt)   | verified for a future interpreter;
 *                |        |              | install attempted, failure is
 *                |        |              | NON-FATAL (node still boots).
 *
 *   macOS (darwin) gets the default / MPS wheel at torch 2.9.1 (no cu
 *   index) regardless of Python minor — see `pickTorchWheel`.
 *
 * NOTE on drivers: the `cu128` wheel needs a driver that supports
 * CUDA ≥ 12.8 (driver ≥ ~570). The prod RunPod A5000/A40 pods already
 * run driver 570 / CUDA 12.8 (see the 2026-05-22 verification), so this
 * loses no working GPU capability. Nodes on older drivers were already
 * unable to run torch ≥ 2.6 GPU and remain so.
 *
 * Bumping torch is a coordinated change: an operator with a mismatched
 * wheel installed (e.g. a stale 2.6.0 / 2.5.1) is migrated on next boot —
 * the version + flavor probe at the top of Phase 2 fails (the
 * `assert torch.__version__.startswith('2.9.1')` rejects the old pin) and
 * triggers a `--force-reinstall` against the correct version + index for
 * their hardware AND Python version.
 */

/** Minimum Python minor version (3.x). */
const REQUIRED_PYTHON_MINOR = 14;

/**
 * Resolved torch version + NVIDIA wheel index for a given Python minor.
 * `bestEffort` flips true when no pinned wheel is known to exist for the
 * interpreter (Python ≥ 3.15) — Phase 2 then treats an install failure
 * as a non-fatal skip rather than a hard error, so the node still boots.
 */
export interface TorchSpec {
  /** Pinned torch version string, e.g. `2.6.0` or `2.9.1`. */
  torchVersion: string;
  /** PyTorch CUDA wheel index used when NVIDIA hardware is detected. */
  nvidiaIndexUrl:
    | 'https://download.pytorch.org/whl/cu121'
    | 'https://download.pytorch.org/whl/cu124'
    | 'https://download.pytorch.org/whl/cu128';
  /** NVIDIA wheel index human label (cu121 / cu124 / cu128) for logging. */
  nvidiaLabel: 'cu121' | 'cu124' | 'cu128';
  /**
   * True when no pinned wheel is verified to exist for this interpreter
   * (Python ≥ 3.15). Install is attempted but failure is non-fatal.
   */
  bestEffort: boolean;
}

/**
 * Pure selector: map a venv Python minor version to its torch spec.
 * See the matrix in the module comment above. Exported for unit tests.
 *
 * `pythonMinor` is the `x` in `3.x`. When detection fails we conserve
 * the safe default (≤14 → 2.9.1/cu128, NOT best-effort) by passing a low
 * minor; callers should only pass a high minor (≥15, which flips
 * bestEffort) when they positively detected one (see
 * `detectVenvPythonMinor`).
 */
export function selectTorchSpec(pythonMinor: number): TorchSpec {
  if (pythonMinor <= 14) {
    // 3.10 / 3.11 / 3.12 / 3.13 / 3.14 → torch 2.9.1 / cu128. 2.9.1 is the
    // oldest stable still served by the default PyPI index (which dropped
    // everything below 2.9.0) and it ships a REAL cp314 wheel on BOTH the
    // default / MPS index AND the cu128 NVIDIA index — so Python 3.14
    // (cp314) is no longer best-effort (the node-kike fix, 2026-05-30).
    // The old 2.6.0 / cu124 pin aged out: default index dropped 2.6.0 and
    // cu124 never carried a cp314 wheel.
    return {
      torchVersion: '2.9.1',
      nvidiaIndexUrl: 'https://download.pytorch.org/whl/cu128',
      nvidiaLabel: 'cu128',
      bestEffort: false,
    };
  }
  // Python ≥ 15: no pinned wheel is verified for a future interpreter.
  // Attempt the same spec (best chance of a forward-compatible wheel) but
  // flag bestEffort so a 404 / build failure does NOT brick node boot.
  return {
    torchVersion: '2.9.1',
    nvidiaIndexUrl: 'https://download.pytorch.org/whl/cu128',
    nvidiaLabel: 'cu128',
    bestEffort: true,
  };
}

/**
 * Detect the venv Python minor version (`x` in `3.x`) by invoking the
 * venv interpreter. Returns the integer minor, or `null` when the venv
 * python can't be probed (absent / errored) — callers then conserve the
 * safe default by treating it as ≤13 (→ 2.6.0/cu124, not best-effort).
 *
 * `pythonBin` + `spawnFn` are injectable for deterministic tests.
 */
export function detectVenvPythonMinor(
  pythonBin: string = venvPython(),
  spawnFn: typeof spawnSync = spawnSync,
): number | null {
  const probe = spawnFn(
    pythonBin,
    ['-c', 'import sys; print(sys.version_info.minor)'],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  if (probe.status !== 0 || probe.error) return null;
  const minor = parseInt((probe.stdout ?? '').toString().trim(), 10);
  return Number.isInteger(minor) ? minor : null;
}

/**
 * Pinned pip spec for the LoRA training stack.
 *
 * `transformers>=4.43,<5`: the 4.43 floor introduced the `dtype` keyword
 * on `from_pretrained` that our DiLoCo / LoRA scripts rely on; the `<5`
 * ceiling is mandatory because transformers 5.x REMOVED the `tokenizer=`
 * kwarg on `Trainer.__init__` (replaced by `processing_class`).
 * `train_lora.py` calls `Trainer(..., tokenizer=tokenizer, ...)`, so an
 * unpinned install that resolves to 5.x (currently 5.9.0) makes every
 * LoRA training run exit with
 *   `TypeError: Trainer.__init__() got an unexpected keyword argument 'tokenizer'`.
 * VERIFIED on the live A5000 (Py 3.12, torch 2.6.0/cu124): `<5` resolves
 * to transformers 4.57.x and `Trainer(tokenizer=...)` is accepted, while
 * 5.9.0 rejects it. peft 0.19.1 / datasets / safetensors / accelerate
 * stay unpinned — they are compatible with transformers 4.57.
 *
 * `protobuf` / `sentencepiece` / `sacremoses` are the tokenizer backends
 * for LORA_CLASSIFICATION on BioGPT-Large. `BioGptTokenizer` requires all
 * three and transformers does NOT pull them in automatically, so without
 * them `train_lora.py` exits code 2 with one of:
 *   - `requires the protobuf library`
 *   - (after protobuf) sentencepiece-backed conversion still fails
 *   - `You need to install sacremoses to use BioGptTokenizer`
 * VERIFIED live on a pod (2026-05-22): with all three present the
 * BioGPT-Large tokenizer + `BioGptForSequenceClassification` load
 * successfully. LORA_GENERATION (causal) does not hit this path. They stay
 * unpinned, consistent with the other tokenizer/runtime deps above.
 */
export const LORA_STACK_PIP_ARGS: readonly string[] = [
  'install',
  'transformers>=4.43,<5',
  'peft',
  'datasets',
  'safetensors',
  'accelerate',
  'protobuf',
  'sentencepiece',
  'sacremoses',
] as const;

/** Human-readable form of the LoRA stack spec, used in operator hints. */
export const LORA_STACK_MANUAL_SPEC = 'transformers>=4.43,<5 peft datasets safetensors accelerate protobuf sentencepiece sacremoses';

/**
 * Pure decision: given the transformers version captured by the
 * "already installed" probe, decide whether the LoRA stack must be
 * (re)installed to satisfy the `transformers>=4.43,<5` pin.
 *
 * Returns `true` (force install / downgrade) when:
 *   - the import probe failed (no version captured), OR
 *   - the captured version's major is ≥ 5 (e.g. the live pods on 5.9.0),
 *     which carries the `tokenizer=`-removed `Trainer`, OR
 *   - the version string can't be parsed into a major (fail-closed: a
 *     stack we can't verify is treated as needing a (re)install).
 *
 * Returns `false` (safe to skip) only when a major in `[4, 5)` is parsed.
 * Exported for unit tests, mirroring `selectTorchSpec` / `pickTorchWheel`.
 */
export function loraStackNeedsReinstall(installedVersion: string | undefined): boolean {
  if (!installedVersion) return true;
  // Leading numeric component is the major (e.g. "5.9.0" → 5, "4.57.6" → 4).
  const major = parseInt(installedVersion.trim().split('.')[0] ?? '', 10);
  if (!Number.isInteger(major)) return true; // unparseable → fail-closed.
  return major >= 5; // ≥5 violates the `<5` pin → force a downgrade.
}

/** Result of selecting which PyTorch wheel index to install from. */
export interface TorchWheelChoice {
  /**
   * Value passed to `pip install --index-url …`. `null` means "do not
   * pass --index-url at all" — let pip resolve from the default PyPI
   * index. Used on macOS where the default wheel ships MPS support.
   */
  indexUrl: string | null;
  /**
   * Human label for logging + telemetry. The NVIDIA flavor (`cu121` /
   * `cu124` / `cu128`) is chosen by `selectTorchSpec` per Python minor.
   */
  label: 'cu121' | 'cu124' | 'cu128' | 'cpu' | 'mps/default';
  /** Whether NVIDIA hardware was detected on this host. */
  hasNvidia: boolean;
  /** Pinned torch version for this host (per `selectTorchSpec`). */
  torchVersion: string;
  /**
   * True when no pinned wheel is verified to exist for this interpreter
   * (Python ≥ 3.15) — Phase 2 treats install failure as a non-fatal
   * skip so the node still boots without torch.
   */
  bestEffort: boolean;
  /** One-line explanation of WHY this wheel was chosen (logged). */
  reason: string;
}

/**
 * Probe for NVIDIA hardware on the local host.
 *
 * Two-stage detection:
 *   1. `nvidia-smi --query-gpu=name --format=csv,noheader` — works on
 *      any host with the NVIDIA driver tools installed. Exits 0 and
 *      prints at least one GPU name when an NVIDIA GPU is attached.
 *   2. `/dev/nvidia0` device file — fallback for stripped-down
 *      containers (some RunPod / vast.ai templates ship without the
 *      `nvidia-smi` CLI but still expose `/dev/nvidia*` to the
 *      container).
 *
 * Per P24 discipline: fail-CLOSED. Any unexpected exception bubbling
 * out of `execSync` / `existsSync` is treated as "no NVIDIA" so a
 * broken probe falls back to the cpu wheel — wrong but harmless —
 * instead of crashing install-deps and bricking node boot.
 *
 * NOTE: this is the production default probe. Tests inject their own
 * via `pickTorchWheel({ nvidiaProbeFn })`.
 */
function defaultNvidiaProbe(): boolean {
  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .toString()
      .trim();
    if (out.length > 0) return true;
  } catch {
    // nvidia-smi missing, non-zero exit, or timed out. Fall through
    // to the device-file fallback — some container images ship the
    // device nodes without the CLI.
  }
  try {
    if (existsSync('/dev/nvidia0')) return true;
  } catch {
    // existsSync on a path like /dev/nvidia0 doesn't normally throw
    // on POSIX, but a hostile mount could in theory — swallow to
    // stay fail-closed.
  }
  return false;
}

/**
 * Decide which PyTorch wheel index to use for THIS host. Pure function
 * — accepts `platform`, `nvidiaProbeFn`, and `spec` overrides so tests
 * can drive every branch without touching real hardware.
 *
 * The torch version + NVIDIA wheel index are Python-version-aware: by
 * default `spec` is resolved from the venv Python minor version via
 * `detectVenvPythonMinor` → `selectTorchSpec` (≤14 → 2.9.1/cu128,
 * ≥15 → 2.9.1/cu128 best-effort). Tests inject `spec` directly.
 *
 * Decision matrix (NVIDIA flavor = spec.nvidiaLabel = cu128):
 *   - macOS (any arch)        → default wheel (MPS via Apple Silicon)
 *   - Linux + NVIDIA detected → cu128 wheel (per Python version)
 *   - Linux + no NVIDIA       → cpu wheel (current pre-slice behaviour)
 *   - Windows + NVIDIA        → cu128 wheel (per Python version)
 *   - Windows + no NVIDIA     → cpu wheel
 *   - Anything else           → cpu wheel (safe default)
 *
 * The reason string is logged and surfaced in the `InstallDepsEvent`
 * for the install phase so operators can see WHY their wheel was
 * picked when debugging "why doesn't torch.cuda.is_available() work".
 */
export function pickTorchWheel(opts: {
  platform?: NodeJS.Platform;
  nvidiaProbeFn?: () => boolean;
  /** Resolved torch spec. Defaults to the venv Python minor selection. */
  spec?: TorchSpec;
} = {}): TorchWheelChoice {
  const platform = opts.platform ?? os.platform();
  const probeFn = opts.nvidiaProbeFn ?? defaultNvidiaProbe;
  // Default spec: detect the venv Python minor; null detection conserves
  // the safe default (treated as ≤14 → 2.9.1/cu128, not best-effort).
  const spec = opts.spec ?? selectTorchSpec(detectVenvPythonMinor() ?? 12);

  // Per P24: any throw from a user-supplied (or default) probe is
  // treated as "no NVIDIA" — never crash install-deps because the
  // hardware probe blew up.
  let hasNvidia = false;
  try {
    hasNvidia = probeFn();
  } catch {
    hasNvidia = false;
  }

  if (platform === 'darwin') {
    return {
      indexUrl: null,
      label: 'mps/default',
      hasNvidia: false, // macOS never gets NVIDIA CUDA; MPS is the GPU path
      torchVersion: spec.torchVersion,
      bestEffort: spec.bestEffort,
      reason: `macOS detected — using default PyPI wheel torch ${spec.torchVersion} (MPS-enabled via Apple Silicon)`,
    };
  }

  if ((platform === 'linux' || platform === 'win32') && hasNvidia) {
    const cudaVer =
      spec.nvidiaLabel === 'cu128' ? '12.8'
      : spec.nvidiaLabel === 'cu124' ? '12.4'
      : '12.1';
    return {
      indexUrl: spec.nvidiaIndexUrl,
      label: spec.nvidiaLabel,
      hasNvidia: true,
      torchVersion: spec.torchVersion,
      bestEffort: spec.bestEffort,
      reason: `NVIDIA GPU detected — installing CUDA ${cudaVer} PyTorch ${spec.torchVersion} (${spec.nvidiaLabel}) wheel for GPU acceleration`,
    };
  }

  if (platform === 'linux' || platform === 'win32') {
    return {
      indexUrl: 'https://download.pytorch.org/whl/cpu',
      label: 'cpu',
      hasNvidia: false,
      torchVersion: spec.torchVersion,
      bestEffort: spec.bestEffort,
      reason: `No NVIDIA GPU detected — installing CPU PyTorch ${spec.torchVersion} wheel`,
    };
  }

  // Unknown platform (freebsd, sunos, aix, …): safest default.
  return {
    indexUrl: 'https://download.pytorch.org/whl/cpu',
    label: 'cpu',
    hasNvidia,
    torchVersion: spec.torchVersion,
    bestEffort: spec.bestEffort,
    reason: `Unsupported platform '${platform}' — falling back to CPU PyTorch ${spec.torchVersion} wheel`,
  };
}

/**
 * Default DiLoCo foundation model. Matches:
 *   - `diloco_train.py` default (`config.get("modelId", "Qwen/Qwen2.5-7B")`)
 *   - coord-side `DiLoCoController` + `DiLoCoRoundCron` defaults.
 * If/when coord starts pinning per-round model ids, this constant becomes
 * a fallback — install-deps would need a `--diloco-model` CLI flag or
 * env override (`SYNAPSEIA_DILOCO_MODEL`) to track per-pod assignments.
 * Today every DiLoCo round uses Qwen2.5-7B so pinning here is correct.
 */
// F-node-014 (MED): the env override has historically been passed
// straight through to the marker-write path and (pre-fix) to a
// string-concatenated shell command. Even though the call site is now
// spawnSync-based, we keep a strict allowlist here so a hostile marker
// file / env value cannot drive non-printable / shell-meta bytes
// downstream into log scrubbers, tarballs, etc. Same shape used by
// `MODEL_ID_ALLOWLIST` in model-downloader.ts (kept inline rather than
// imported to avoid a circular module).
const DILOCO_MODEL_ID_ALLOWLIST = /^[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)?$/;

function resolveDilocoModelId(): string {
  const raw = process.env.SYNAPSEIA_DILOCO_MODEL?.trim();
  if (!raw) return 'Qwen/Qwen2.5-7B';
  if (raw.length > 256 || !DILOCO_MODEL_ID_ALLOWLIST.test(raw)) {
    logger.warn(
      `[install-deps] SYNAPSEIA_DILOCO_MODEL="${raw}" rejected by allowlist; falling back to Qwen/Qwen2.5-7B`,
    );
    return 'Qwen/Qwen2.5-7B';
  }
  return raw;
}

const DEFAULT_DILOCO_MODEL_ID = resolveDilocoModelId();

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
 *   2. torch         — pip install torch wheel selected per host AND
 *                      Python version: NVIDIA Linux/Win → cu128
 *                      (torch 2.9.1, cp310-cp314), macOS → default (MPS),
 *                      everything else → cpu. Migrating an existing
 *                      cpu→NVIDIA or stale 2.6.0 / 2.5.1 install uses
 *                      --force-reinstall.
 *   3. lora-stack    — pip install transformers + peft + datasets + safetensors + accelerate
 *                      + protobuf + sentencepiece + sacremoses (BioGPT-Large
 *                      tokenizer backends for LORA_CLASSIFICATION)
 *                      (only on Tier 1+ nodes with enough RAM/VRAM)
 *   4. cuda-probe    — probe torch.cuda.is_available() for telemetry
 *                      (informational; Phase 5 gates on wheel choice)
 *   5. bitsandbytes  — pip install bitsandbytes (only when an NVIDIA
 *                      wheel — cu124 — was installed in Phase 2)
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
  // Pick the wheel BEFORE the version probe so the "already installed"
  // path can also verify the installed wheel matches the expected
  // flavor (cu124 on NVIDIA, mps/default on macOS, cpu otherwise).
  // Without that check, an operator who installed cpu torch under the
  // old hardcoded path would be left with a stale cpu wheel even after
  // attaching an A40 — `torch.cuda.is_available()` would still return
  // False and DiLoCo would still OOM.
  //
  // The torch VERSION + NVIDIA index are Python-version-aware (see
  // `selectTorchSpec`): every supported host (cp310-cp314) gets torch
  // 2.9.1 / cu128. A node on a stale 2.6.0 / 2.5.1 wheel is
  // force-reinstalled up to 2.9.1 (the version probe below rejects the
  // old pin). `pickTorchWheel` resolves the spec from
  // `detectVenvPythonMinor()` internally.
  const torchWheel = pickTorchWheel();
  const torchVersion = torchWheel.torchVersion;
  logger.log(`[install-deps] ${torchWheel.reason}`);

  // Two-part probe:
  //   1. version matches the DYNAMICALLY-chosen pin (import + __version__).
  //   2. CUDA-availability matches the expected wheel flavor.
  //      - cu121/cu124 wheel must expose torch.cuda.is_available() == True
  //      - cpu / mps wheels must expose torch.cuda.is_available() == False
  //      Either mismatch → force reinstall against the correct index.
  const isNvidiaWheel =
    torchWheel.label === 'cu121'
    || torchWheel.label === 'cu124'
    || torchWheel.label === 'cu128';
  const expectCuda = isNvidiaWheel;
  const torchProbeScript = [
    'import torch, sys',
    `assert torch.__version__.startswith('${torchVersion}'), torch.__version__`,
    `cuda_ok = torch.cuda.is_available()`,
    `expect_cuda = ${expectCuda ? 'True' : 'False'}`,
    'sys.exit(0 if cuda_ok == expect_cuda else 2)',
  ].join('\n');
  const torchProbe = spawnSync(
    venvPython(),
    ['-c', torchProbeScript],
    { stdio: 'pipe' },
  );
  const torchInstalledAndMatches = torchProbe.status === 0;

  if (torchInstalledAndMatches) {
    emit({
      phase: 'torch',
      status: 'skip',
      message: `PyTorch ${torchVersion} (${torchWheel.label}) already installed`,
    });
  } else {
    // status == 2 means version OK but wheel flavor wrong → MIGRATING.
    // Any other failure (1, null, missing) means torch absent or wrong
    // version. Both cases need an install. We pass --force-reinstall
    // when migrating so pip will overwrite the existing same-version
    // cpu wheel with the NVIDIA (or vice versa) wheel; without it pip
    // would see "torch==X already installed" and no-op.
    //
    // F-node-014 (MED): switched from `execSync(installCmd: string)` to
    // `spawnSync(bin, [...args])` so torchWheel.indexUrl (built from
    // env-driven hardware detection) and the torch version can no longer
    // be shell-interpreted. The previous shape would have exploded on any
    // unsanitized space/quote/semicolon in either value.
    const isMigrating = torchProbe.status === 2;
    const torchInstallArgs = [
      'install',
      `torch==${torchVersion}`,
      ...(torchWheel.indexUrl ? ['--index-url', torchWheel.indexUrl] : []),
      ...(isMigrating ? ['--force-reinstall'] : []),
    ];
    // Human-readable hint for error logs: we keep the SHAPE of the
    // legacy command, but every dynamic value is interpolated INTO an
    // already-built arg list, not into a shell string. The hint string
    // is for the operator to copy-paste; it never feeds back into
    // spawnSync.
    const installHint = `"${venvPip()}" ${torchInstallArgs.map((a) => a.includes(' ') ? JSON.stringify(a) : a).join(' ')}`;

    const migratedFrom = isNvidiaWheel ? 'cpu' : torchWheel.label;
    const runningMsg = isMigrating
      ? `Migrating PyTorch to ${torchWheel.label} wheel (was ${migratedFrom}); reinstalling ${torchVersion}...`
      : `Installing PyTorch ${torchVersion} (${torchWheel.label} wheel)...`;
    emit({ phase: 'torch', status: 'running', message: runningMsg });

    const torchInstallProc = spawnSync(venvPip(), torchInstallArgs, { stdio: 'inherit' });
    if (torchInstallProc.status === 0) {
      result.installedTorch = true;
      emit({
        phase: 'torch',
        status: 'done',
        message: `PyTorch ${torchVersion} (${torchWheel.label}) installed`,
      });
    } else {
      const errMsg = torchInstallProc.error?.message ?? `pip exited with status ${torchInstallProc.status}`;
      if (torchWheel.bestEffort) {
        // Python ≥ 3.15: no pinned torch wheel is verified for a future
        // interpreter (cp310-cp314 all have a 2.9.1 wheel; cp315+ may not
        // yet). The install was attempted but a 404 / build failure here
        // is EXPECTED on the bleeding edge — do NOT hard-fail the node.
        // Emit a non-fatal skip; the node boots without torch and simply
        // won't advertise training caps until a wheel exists upstream.
        const msg = `PyTorch ${torchVersion} (${torchWheel.label}) unavailable for this Python version (best-effort, no pinned wheel verified for this interpreter yet): ${errMsg}. Node will boot WITHOUT torch / training caps. Manual attempt: ${installHint}`;
        emit({ phase: 'torch', status: 'skip', message: msg });
        // Intentionally NOT pushed to result.errors — best-effort failure
        // is not a node-boot failure.
      } else {
        const msg = `PyTorch install failed: ${errMsg}. Try manually: ${installHint}`;
        emit({ phase: 'torch', status: 'error', message: msg });
        result.errors.push(msg);
        // Continue — LoRA install will likely fail too, but we let the next
        // phase decide rather than aborting the whole flow here.
      }
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
    // Extract the captured transformers version (last stdout line) so the
    // skip decision can enforce the `<5` ceiling, not just presence.
    const probedVersion = loraProbe.status === 0
      ? ((loraProbe.stdout ?? '').toString().trim().split('\n').pop()?.trim() || undefined)
      : undefined;
    if (loraProbe.status === 0 && !loraStackNeedsReinstall(probedVersion)) {
      // Already-installed path AND the installed transformers satisfies
      // the `transformers>=4.43,<5` pin. Write the marker NOW so the next
      // node boot can prime its cache without re-spawning the probe.
      // Without this, an operator who pre-installed deps manually
      // would never get marker coverage until they hit phase 3 install.
      writeMarkerFromProbe(loraProbe);
      emit({ phase: 'lora-stack', status: 'skip', message: 'LoRA training stack already installed' });
    } else {
      // Either the stack is absent, OR an installed transformers ≥ 5 must
      // be downgraded: 5.x removed `Trainer(tokenizer=...)`, which
      // `train_lora.py` passes, so the live pods on 5.9.0 stay broken
      // unless this install forces them back under the `<5` ceiling.
      const downgrade = loraProbe.status === 0;
      emit({
        phase: 'lora-stack',
        status: 'running',
        message: downgrade
          ? `Reinstalling LoRA training stack to satisfy transformers<5 (found ${probedVersion ?? 'unknown'})...`
          : 'Installing LoRA training stack (~500MB)...',
      });
      // F-node-014 (MED): static arg list — no env-driven values feed
      // into the spawn (the package names are literal in code). Still
      // spawnSync rather than execSync to keep ONE shell-injection-free
      // shape across the file (no per-call exception).
      const loraInstallProc = spawnSync(
        venvPip(),
        [...LORA_STACK_PIP_ARGS],
        { stdio: 'inherit' },
      );
      if (loraInstallProc.status === 0) {
        // Spec is `transformers>=4.43,<5` (see LORA_STACK_PIP_ARGS): the
        // 4.43 floor gives the `dtype` keyword on `from_pretrained` our
        // DiLoCo / LoRA scripts rely on, and the `<5` ceiling keeps the
        // `Trainer(tokenizer=...)` kwarg that `train_lora.py` passes —
        // 5.x removed it (→ `processing_class`), breaking every LoRA run.
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
      } else {
        // pip failed outright — also remove any stale marker so
        // we don't advertise caps based on a previous run.
        deleteLoraStackMarker();
        const errMsg = loraInstallProc.error?.message ?? `pip exited with status ${loraInstallProc.status}`;
        const msg = `LoRA stack install failed: ${errMsg}. Try manually: "${venvPip()}" install "${LORA_STACK_MANUAL_SPEC}"`;
        emit({ phase: 'lora-stack', status: 'error', message: msg });
        result.errors.push(msg);
      }
    }
  }

  // ── Phase 4: cuda-probe ─────────────────────────────────────────────────
  // Slice 16: this phase used to be the SOLE source of truth for whether
  // bitsandbytes should install. That broke when the hardcoded cpu wheel
  // hid real CUDA hardware (A40 pods showing is_available()==False). The
  // probe still runs for informational telemetry, but Phase 5 now gates
  // on the wheel CHOICE (isNvidiaWheel — cu121 / cu124 / cu128), which is
  // the upstream signal — if we installed a CUDA wheel, we want bnb.
  const cudaProbe = spawnSync(
    venvPython(),
    ['-c', 'import torch; print("cuda_ok=" + str(torch.cuda.is_available()))'],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  const cudaRuntimeOk =
    cudaProbe.status === 0
    && !cudaProbe.error
    && (cudaProbe.stdout ?? '').toString().includes('cuda_ok=True');
  if (cudaRuntimeOk) {
    emit({ phase: 'cuda-probe', status: 'done', message: 'CUDA available at runtime' });
  } else if (isNvidiaWheel) {
    // Wheel says CUDA but runtime disagrees — likely a missing driver
    // or libc++ mismatch. Surface as a warning, but still attempt bnb
    // (it may still install; runtime DiLoCo will fail loudly if not).
    // NOTE: a cu128 wheel needs driver ≥ ~570 (CUDA 12.8) — an older
    // driver on a cp31x host produces exactly this branch.
    emit({
      phase: 'cuda-probe',
      status: 'error',
      message: `${torchWheel.label} torch wheel installed but torch.cuda.is_available()=False — check NVIDIA driver / libcuda (cu128 needs driver ≥ ~570)`,
    });
  } else {
    emit({ phase: 'cuda-probe', status: 'skip', message: 'CUDA not available (CPU-only / MPS node)' });
  }

  // ── Phase 5: bitsandbytes ───────────────────────────────────────────────
  // Gated on the wheel choice, not the runtime cuda probe. Rationale:
  // if we installed an NVIDIA wheel (cu121 / cu124 / cu128), the operator's
  // intent is GPU compute, and bnb is required for DiLoCo 4-bit. A failed runtime
  // probe (driver issue) shouldn't suppress bnb install — better to
  // have bnb available and surface the driver problem separately than
  // to skip bnb and have DiLoCo silently fall back to fp32 OOM.
  if (isNvidiaWheel) {
    const bnbProbe = spawnSync(
      venvPython(),
      ['-c', 'import bitsandbytes'],
      { stdio: 'pipe' },
    );
    if (bnbProbe.status === 0) {
      emit({ phase: 'bitsandbytes', status: 'skip', message: 'bitsandbytes already installed' });
    } else {
      emit({ phase: 'bitsandbytes', status: 'running', message: 'Installing bitsandbytes for DiLoCo full mode...' });
      // F-node-014: spawnSync with argv — `bitsandbytes` is a literal,
      // but we keep the same shape as the torch/lora installs so the
      // file has no remaining execSync(string) for an installer cmd.
      const bnbInstallProc = spawnSync(venvPip(), ['install', 'bitsandbytes'], { stdio: 'inherit' });
      if (bnbInstallProc.status === 0) {
        result.installedBitsAndBytes = true;
        emit({ phase: 'bitsandbytes', status: 'done', message: 'bitsandbytes installed' });
      } else {
        const errMsg = bnbInstallProc.error?.message ?? `pip exited with status ${bnbInstallProc.status}`;
        const msg = `bitsandbytes install failed: ${errMsg}. DiLoCo full mode requires it for 4-bit quantization. Try: "${venvPip()}" install bitsandbytes`;
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
