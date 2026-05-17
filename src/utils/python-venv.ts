import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
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

/**
 * Persistent on-disk marker file recording that the LoRA Python stack
 * (transformers + peft + datasets + safetensors + accelerate) has been
 * successfully imported against `venvPython()` at least once.
 *
 * Bug 12 v2 (root cause): pre-fix code re-spawned the import probe at every
 * 60s heartbeat. Cold `import transformers` on a busy pod takes 4-5s and
 * occasionally exceeds the 60s timeout (verified live 2026-05-17: POD1
 * oscillated caps every ~3min between 7 and 9 — coordinator log
 * `caps drift detected peer=POD1 added=[gpu_training,lora_training]` /
 * `removed=[gpu_training,lora_training]` rotated 4x per ~10min window).
 * The positive cache only persisted within a single process — every restart
 * forced a fresh race, and within a run any single timeout poisoned the
 * cap set until the next successful probe.
 *
 * Marker-based fix: install-deps writes this marker after a successful
 * post-install verification. At node boot we read the marker — if its
 * `venvPython` field matches the current resolved interpreter, the cache
 * is primed before the first heartbeat tick and no probe ever spawns at
 * runtime. Per-tick `isLoraStackAvailable()` becomes O(1).
 */
export const LORA_STACK_MARKER = process.env.SYNAPSEIA_HOME
  ? join(process.env.SYNAPSEIA_HOME, 'lora-stack-ok')
  : join(homedir(), '.synapseia', 'lora-stack-ok');

/**
 * Persistent on-disk marker file recording that the DiLoCo foundation
 * model has been pre-downloaded into the local Hugging Face cache.
 *
 * Bug 18 v3 (root cause): DiLoCo work orders crashed mid-load with
 * "exit code null" because `AutoModelForCausalLM.from_pretrained()`
 * hit Hugging Face Hub at runtime. Anonymous downloads of a 7B model
 * (~13 GB across multiple shards) got throttled / RST'd partway,
 * killing the Python process with SIGPIPE / SIGSEGV inside the
 * safetensors / hf_transfer native extensions. HF_TOKEN helped but
 * still failed on flaky pod networks because the request volume per
 * accept (10+ shard downloads per cold start) compounded the failure
 * probability.
 *
 * Fix: install-deps pre-downloads the model ONCE (at install time,
 * which is tolerant of slow / rate-limited fetches because there's no
 * WO timeout). The runtime script then opens with
 * `local_files_only=True` and never touches HF Hub. The heartbeat
 * gates the `diloco_training` capability on this marker — pods that
 * failed to pre-download simply don't advertise the cap, so the
 * coordinator routes the WO elsewhere instead of letting it crash.
 *
 * Marker shape: `{ modelId, cacheDir, downloadedAt, sizeBytes }`.
 * `modelId` is the HF identifier (e.g. `Qwen/Qwen2.5-7B`).
 * `cacheDir` is the absolute snapshot path inside the HF cache so
 * the runtime script can pass it as `cache_dir=...` for deterministic
 * resolution. `sizeBytes` is captured at write time for forensic
 * inspection of `~/.synapseia/diloco-model-ok` — no runtime reader.
 * `downloadedAt` is unix epoch millis for the same forensic purpose.
 */
export const DILOCO_MODEL_MARKER = process.env.SYNAPSEIA_HOME
  ? join(process.env.SYNAPSEIA_HOME, 'diloco-model-ok')
  : join(homedir(), '.synapseia', 'diloco-model-ok');

/**
 * Persisted shape. Kept intentionally small (≤ 200 bytes typical) so a
 * single fsync covers the whole file.
 *
 * `venvPython` MUST be the absolute interpreter path that successfully
 * imported the stack — heartbeat boot compares it against
 * `venvPython()` to invalidate when an operator rebuilds the venv at a
 * different path.
 *
 * `transformersVersion` (optional) carries the result of
 * `transformers.__version__` from the probe stdout. Persisted for
 * forensic inspection of `~/.synapseia/lora-stack-ok` — no runtime
 * reader. Absence is non-fatal.
 *
 * Bug 12 v2 (reviewer MED-1): the previous `installedAt` field was
 * removed because no code path read it. We do NOT stale the marker by
 * age — a venv that imported the stack last week still has the stack
 * today unless the operator removed it, in which case the runtime
 * probe fallback (see `isLoraStackAvailable`) catches the drift on
 * first failure.
 */
export interface LoraStackMarker {
  venvPython: string;
  transformersVersion?: string;
}

/**
 * Read + validate the on-disk LoRA stack marker. Returns `null` on:
 *   - file absent
 *   - file unreadable (perm denied, IO error)
 *   - JSON parse failure (corrupt / truncated content)
 *   - `venvPython` field mismatch vs current `venvPython()` resolution
 *     (operator rebuilt venv at a different path, marker is stale)
 *
 * Callers that get `null` MUST fall back to spawning the real probe.
 *
 * @param current absolute path of the currently-resolved venv python —
 *   passed in to keep this helper deterministic for tests.
 */
export function readLoraStackMarker(
  current: string = venvPython(),
): LoraStackMarker | null {
  if (!existsSync(LORA_STACK_MARKER)) return null;
  let raw: string;
  try {
    raw = readFileSync(LORA_STACK_MARKER, 'utf-8');
  } catch (err) {
    logger.warn(`[python-venv] LoRA marker unreadable: ${(err as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — treat as absent. The probe will re-write a fresh
    // marker on next success. Logging avoided to prevent noise on
    // every boot when the marker is genuinely garbage.
    return null;
  }
  if (
    typeof parsed !== 'object' || parsed === null
    || typeof (parsed as Record<string, unknown>).venvPython !== 'string'
  ) {
    return null;
  }
  const marker = parsed as LoraStackMarker;
  if (marker.venvPython !== current) {
    // Venv path changed (operator nuked + recreated, or moved
    // SYNAPSEIA_HOME). Marker is stale — refuse to trust the cache.
    return null;
  }
  return marker;
}

/**
 * Atomically write the LoRA stack marker. Writes to `<path>.tmp` then
 * `rename()` — POSIX guarantees rename is atomic on the same filesystem,
 * so a concurrent reader sees either the old marker or the new marker,
 * never a partial write. Used by install-deps after the post-install
 * verification probe succeeds.
 *
 * On Windows `rename()` over an existing file raises EPERM, so we
 * unlink first if the target exists. This loses atomicity briefly but
 * the marker is advisory (worst-case: heartbeat re-spawns the probe
 * during the gap).
 *
 * Non-throwing: returns true on success, false on any IO failure. The
 * caller logs — the install flow MUST NOT crash because the cache file
 * is unwritable (operator can still run with per-tick probing).
 */
export function writeLoraStackMarker(marker: LoraStackMarker): boolean {
  try {
    mkdirSync(dirname(LORA_STACK_MARKER), { recursive: true });
    const tmp = `${LORA_STACK_MARKER}.tmp`;
    writeFileSync(tmp, JSON.stringify(marker), { encoding: 'utf-8' });
    if (process.platform === 'win32' && existsSync(LORA_STACK_MARKER)) {
      try { unlinkSync(LORA_STACK_MARKER); } catch { /* tolerate */ }
    }
    renameSync(tmp, LORA_STACK_MARKER);
    return true;
  } catch (err) {
    logger.warn(`[python-venv] LoRA marker write failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Best-effort delete of the LoRA stack marker. Called by install-deps
 * when the post-install verification fails, AND by heartbeat probe
 * fallback when a runtime probe fails (operator may have `pip
 * uninstall`ed transformers after the marker was written — we MUST
 * delete the now-lying marker so the next boot re-probes honestly).
 *
 * Non-throwing: missing file is treated as success.
 */
export function deleteLoraStackMarker(): void {
  try {
    if (existsSync(LORA_STACK_MARKER)) unlinkSync(LORA_STACK_MARKER);
  } catch (err) {
    logger.warn(`[python-venv] LoRA marker delete failed: ${(err as Error).message}`);
  }
}

/**
 * Persisted DiLoCo model marker shape. Mirrors the LoRA marker design:
 * write atomically via tmp+rename, validate strictly on read, treat any
 * IO failure as "marker absent" (forces a fresh probe / re-download).
 *
 * `modelId` MUST match the HF identifier the runtime script will load.
 * If install-deps pinned a different model id than the runtime expects,
 * the cap is dropped — the operator has to re-run install-deps to
 * realign. This is safer than trusting a marker for `Qwen/Qwen2.5-7B`
 * when the runtime is actually trying to load `microsoft/biogpt`.
 *
 * `cacheDir` is the absolute snapshot path (e.g.
 * `~/.cache/huggingface/hub/models--Qwen--Qwen2.5-7B/snapshots/abcdef`)
 * — the runtime script passes this to `from_pretrained(cache_dir=...)`.
 */
export interface DilocoModelMarker {
  modelId: string;
  cacheDir: string;
  downloadedAt: number;
  sizeBytes: number;
}

/**
 * Read + validate the DiLoCo model marker. Returns `null` on:
 *   - file absent / unreadable / corrupt JSON
 *   - missing required fields (modelId, cacheDir, downloadedAt, sizeBytes)
 *   - `modelId` mismatch vs caller-provided `expectedModelId`
 *   - `cacheDir` no longer exists on disk (operator deleted the HF cache)
 *
 * Heartbeat callers that get `null` MUST NOT advertise `diloco_training`.
 */
export function readDilocoModelMarker(
  expectedModelId: string,
): DilocoModelMarker | null {
  if (!existsSync(DILOCO_MODEL_MARKER)) return null;
  let raw: string;
  try {
    raw = readFileSync(DILOCO_MODEL_MARKER, 'utf-8');
  } catch (err) {
    logger.warn(`[python-venv] DiLoCo marker unreadable: ${(err as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p['modelId'] !== 'string'
    || typeof p['cacheDir'] !== 'string'
    || typeof p['downloadedAt'] !== 'number'
    || typeof p['sizeBytes'] !== 'number'
  ) {
    return null;
  }
  const marker: DilocoModelMarker = {
    modelId: p['modelId'] as string,
    cacheDir: p['cacheDir'] as string,
    downloadedAt: p['downloadedAt'] as number,
    sizeBytes: p['sizeBytes'] as number,
  };
  if (marker.modelId !== expectedModelId) return null;
  // Cache dir disappeared (operator nuked ~/.cache/huggingface). The
  // marker is lying — refuse to trust it so the heartbeat doesn't
  // advertise a cap whose backing weights are gone. Delete is left to
  // the caller — read is observation-only.
  if (!existsSync(marker.cacheDir)) return null;
  return marker;
}

/**
 * Atomic write of the DiLoCo model marker. Same tmp+rename pattern as
 * `writeLoraStackMarker`. Non-throwing: returns true on success, false
 * on any IO failure.
 */
export function writeDilocoModelMarker(marker: DilocoModelMarker): boolean {
  try {
    mkdirSync(dirname(DILOCO_MODEL_MARKER), { recursive: true });
    const tmp = `${DILOCO_MODEL_MARKER}.tmp`;
    writeFileSync(tmp, JSON.stringify(marker), { encoding: 'utf-8' });
    if (process.platform === 'win32' && existsSync(DILOCO_MODEL_MARKER)) {
      try { unlinkSync(DILOCO_MODEL_MARKER); } catch { /* tolerate */ }
    }
    renameSync(tmp, DILOCO_MODEL_MARKER);
    return true;
  } catch (err) {
    logger.warn(`[python-venv] DiLoCo marker write failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Best-effort delete of the DiLoCo model marker. Non-throwing.
 */
export function deleteDilocoModelMarker(): void {
  try {
    if (existsSync(DILOCO_MODEL_MARKER)) unlinkSync(DILOCO_MODEL_MARKER);
  } catch (err) {
    logger.warn(`[python-venv] DiLoCo marker delete failed: ${(err as Error).message}`);
  }
}

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
