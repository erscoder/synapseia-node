/**
 * Hardware detection and hardware-class calculation.
 *
 * `hardwareClass` (0-5, VRAM-bucket-derived) is distinct from the on-chain
 * staking tier persisted in `nodes.tier` Postgres column on the coord side.
 * Hardware class is a self-reported capability hint; staking tier gates
 * WO acceptance and reward multipliers and is sourced from on-chain stake.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { URL } from 'url';
import { Injectable } from '@nestjs/common';

import type { ModelCategory } from '../model/model-catalog';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';

/**
 * Module-level flag to ensure the boot diagnostic only fires once per
 * process. `detectHardware()` is invoked repeatedly by `canInference()` /
 * `canDiLoCo()` during cap-build per heartbeat. Without this flag, the
 * `[hardware]` line would spam logs at info level forever.
 */
let hardwareLoggedOnce = false;

/**
 * Process-lifetime cache for `detectHardware()` results. GPU/CPU/RAM do
 * not change between heartbeats, but `canInference()` and `canDiLoCo()`
 * call `detectHardware()` every 60s on the hot path. On a Windows host
 * without nvidia-smi, the synchronous `execSync` invocation can hang
 * cmd.exe indefinitely (PATH lookup, antivirus interception, network
 * drive scan) and block the main event loop, killing heartbeats. Caching
 * the first probe result eliminates 99% of those spawns.
 *
 * Key is `${cpuOnly}|${archOverride ?? ''}` so distinct call sites with
 * different args retain independent cached values. Tests reset via
 * `resetHardwareCache()`.
 */
const hardwareCache: Map<string, Hardware> = new Map();

/**
 * Reset the hardware detection cache. Exposed for tests so each case
 * can re-probe with fresh mocks. Not intended for production callers.
 */
export function resetHardwareCache(): void {
  hardwareCache.clear();
}

/**
 * Default per-spawn timeout for nvidia-smi invocations (ms). Defensive
 * upper bound so a wedged cmd.exe / antivirus scan cannot block the
 * main thread indefinitely on Windows hosts. Treat timeout as "no GPU".
 */
const NVIDIA_SMI_TIMEOUT_MS = 3000;

/**
 * Pre-flight check: does an executable named `name` exist anywhere on
 * the current process PATH? Walks `process.env.PATH` synchronously
 * using `fs.existsSync` so we never spawn a child for the check. On
 * Windows, also tests `name.exe`. Returns true when found, false
 * otherwise (no GPU / no driver / no binary).
 *
 * This is the primary defense against the Windows hang: when
 * nvidia-smi is missing we never invoke cmd.exe at all.
 */
function isExecutableOnPath(name: string): boolean {
  const pathEnv = process.env.PATH || process.env.Path || '';
  if (!pathEnv) return false;
  const sep = process.platform === 'win32' ? ';' : ':';
  const candidates = process.platform === 'win32'
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(dir, candidate))) return true;
      } catch {
        // Permission denied on some PATH entry. Skip and continue.
      }
    }
  }
  return false;
}

/**
 * Model compatibility info
 */
export interface ModelInfo {
  name: string;
  minVram: number; // GB
  recommendedTier: number;
  category?: ModelCategory; // Optional category for compatibility with model-catalog
  description?: string;
}

/**
 * System information
 */
export interface SystemInfo {
  os: string;
  cpu: {
    model: string;
    cores: number;
  };
  memory: {
    totalGb: number;
  };
  gpu: {
    type: string | null;
    vramGb: number;
  };
}

export interface Hardware {
  cpuCores: number;
  ramGb: number;
  gpuVramGb: number;
  /** Human-readable GPU/CPU model (e.g. "Apple M1 Pro", "NVIDIA RTX 4090"). */
  gpuModel?: string;
  /**
   * Hardware class (0-5), derived from VRAM bucket + CPU/GPU model.
   *
   * Distinct from the staking tier — the coordinator gates WO acceptance
   * and reward multipliers from `nodes.tier` (Postgres, synced from on-chain
   * stake by StakingTierSyncService). This value is purely a self-reported
   * capability hint and MUST NOT be read as a stake-policy signal.
   */
  hardwareClass: number;
  hasOllama: boolean;
  /** True when the node has a cloud LLM URL configured (--llm-url) */
  hasCloudLlm?: boolean;
}

export type HardwareTier = 0 | 1 | 2 | 3 | 4 | 5;

const GPUS: Record<string, HardwareTier> = {
  'Apple M3 Max': 5,
  'Apple M3 Ultra': 5,
  'Apple M3 Pro': 4,
  'Apple M2 Ultra': 3,
  'Apple M2 Max': 3,
  'Apple M2 Pro': 2,
  'Apple M1 Ultra': 2,
  'Apple M1 Max': 2,
  'Apple M2 / M1 Pro': 2,
  'Apple M1 / M1 Air': 1,
  'Apple M1 / M1 Mini': 1,
  'Apple M3 / M3 Pro': 4,
  'NVIDIA RTX 4090': 5,
  'NVIDIA RTX 5090': 5,
  'NVIDIA RTX 6000 Ada': 5,
  'NVIDIA H100': 5,
  'NVIDIA A100': 4,
  'NVIDIA RTX 3090': 4,
  'NVIDIA RTX 4080': 4,
  'NVIDIA RTX 4070': 3,
  'NVIDIA RTX 3080': 3,
  'NVIDIA RTX 4060': 2,
  'NVIDIA RTX 3070': 2,
  'NVIDIA RTX 3060': 2,
  'NVIDIA RTX 4080 Laptop': 2,
  'Intel Arc': 1,
};

@Injectable()
export class HardwareHelper {
  /**
   * Detect hardware capabilities
   */
  /** @internal exported for testing */
  detectAppleSilicon(hardware: Hardware, model: string): void {
    if (model.includes('M3 Ultra')) hardware.hardwareClass = 5;
    else if (model.includes('M3 Max') || model.includes('M3 Pro')) hardware.hardwareClass = 4;
    else if (model.includes('M2 Ultra')) hardware.hardwareClass = 3;
    else if (model.includes('M2 Max')) hardware.hardwareClass = 3;
    else if (model.includes('M2 Pro') || model.includes('M1 Ultra')) hardware.hardwareClass = 2;
    else if (model.includes('M1 Max')) hardware.hardwareClass = 2;
    else if (model.includes('M3') || model.includes('M2') || model.includes('M1')) hardware.hardwareClass = 1;

    // Apple Silicon GPU VRAM estimates
    if (model.includes('Ultra')) hardware.gpuVramGb = hardware.hardwareClass === 5 ? 192 : 128;
    else if (model.includes('Max')) hardware.gpuVramGb = 96; // Max models always set tier to 4 or 3 before this, so tier===5 never happens
    else if (model.includes('Pro')) hardware.gpuVramGb = hardware.hardwareClass >= 3 ? 48 : 18;
    else hardware.gpuVramGb = hardware.hardwareClass === 1 ? 10 : 7;
  }

  /** @internal exported for testing */
  detectNvidiaGPU(hardware: Hardware, smiOutput?: string): void {
    if (!smiOutput) {
      // Pre-flight: if nvidia-smi is not on PATH we must NOT invoke a
      // shell. On Windows, spawning a missing binary routes through
      // cmd.exe which can hang on PATH walks / antivirus scans and
      // block the main thread indefinitely (production bug 2026-05-13).
      if (!isExecutableOnPath('nvidia-smi')) {
        return;
      }
      smiOutput = execSync(
        'nvidia-smi --query-gpu=memory.free --format=csv,noheader',
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: NVIDIA_SMI_TIMEOUT_MS,
        },
      );
    }

    if (smiOutput.includes('GiB')) {
      const match = smiOutput.match(/(\d+)\s*GiB/);
      if (match) hardware.gpuVramGb = parseInt(match[1]);
    } else if (smiOutput.includes('MiB')) {
      const match = smiOutput.match(/(\d+)\s*MiB/);
      if (match) hardware.gpuVramGb = Math.round(parseInt(match[1]) / 1024);
    } else {
      // Bare number fallback (in case --format omits suffix or nvidia-smi
      // build emits raw MiB without unit). Treat as MiB.
      const match = smiOutput.match(/^\s*(\d+)\s*$/m);
      if (match) hardware.gpuVramGb = Math.round(parseInt(match[1]) / 1024);
    }

    // Determine tier based on VRAM
    if (hardware.gpuVramGb >= 80) hardware.hardwareClass = 5;
    else if (hardware.gpuVramGb >= 64) hardware.hardwareClass = 5;
    else if (hardware.hardwareClass < 5 && hardware.gpuVramGb >= 24) hardware.hardwareClass = 4;
    else if (hardware.hardwareClass < 4 && hardware.gpuVramGb >= 14) hardware.hardwareClass = 3;
    else if (hardware.hardwareClass < 3 && hardware.gpuVramGb >= 10) hardware.hardwareClass = 2;
    else if (hardware.hardwareClass < 2 && hardware.gpuVramGb >= 6) hardware.hardwareClass = 1;
  }

  detectHardware(cpuOnly = false, archOverride?: string): Hardware {
    // Process-lifetime cache lookup. GPU/CPU/RAM does not change between
    // heartbeats, so we probe once per (cpuOnly, archOverride) pair and
    // reuse. This is the single highest-impact protection against the
    // Windows nvidia-smi hang: re-running execSync per heartbeat is the
    // amplifier that converted a flaky probe into a frozen process.
    const cacheKey = `${cpuOnly}|${archOverride ?? ''}`;
    const cached = hardwareCache.get(cacheKey);
    if (cached) return cached;

    const hardware: Hardware = {
      cpuCores: os.cpus().length || 2,
      ramGb: Math.round(os.totalmem() / (1024 ** 3)),
      gpuVramGb: 0,
      hardwareClass: 0,
      hasOllama: false,
    };

    if (!cpuOnly) {
      // Detect GPU
      try {
        const arch = archOverride || os.arch();
        if (arch === 'arm64') {
          const model = execSync(
            'sysctl -n machdep.cpu.brand_string',
            { timeout: NVIDIA_SMI_TIMEOUT_MS },
          ).toString().trim();
          this.detectAppleSilicon(hardware, model);
          hardware.gpuModel = model;
        } else if (arch === 'x64' || arch === 'x86') {
          // Node returns 'x64' on modern Intel/AMD; 'x86' kept for historic compat.
          this.detectNvidiaGPU(hardware);
          // Best-effort GPU name for telemetry. Skip the spawn entirely
          // if nvidia-smi is not on PATH. Silent on any failure.
          if (isExecutableOnPath('nvidia-smi')) {
            try {
              const name = execSync(
                'nvidia-smi --query-gpu=name --format=csv,noheader',
                {
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'ignore'],
                  timeout: NVIDIA_SMI_TIMEOUT_MS,
                },
              ).split('\n')[0]?.trim();
              if (name) hardware.gpuModel = name;
            } catch { /* no nvidia-smi or timeout */ }
          }
        }
      } catch {
        // nvidia-smi not available or no GPU
      }

      // Check for Ollama. Honor OLLAMA_URL so containerized nodes that talk
      // to a sibling Ollama container (e.g. http://ollama:11434) can detect
      // the daemon. Fallback to localhost for dev-on-host setups.
      //
      // SECURITY: parse via WHATWG URL + invoke curl via spawnSync (array
      // form) so OLLAMA_URL is never interpolated into a shell. Defense in
      // depth against malformed values like `http://x;rm -rf /tmp/foo`,
      // backticks, `&`, `?`, `$`, etc.
      const ollamaUrl = process.env.OLLAMA_URL?.trim() || 'http://localhost:11434';
      let probeUrl: string | null = null;
      try {
        const parsed = new URL(ollamaUrl);
        probeUrl = `${parsed.origin}/api/tags`;
      } catch {
        // Malformed OLLAMA_URL — treat as no Ollama reachable.
        probeUrl = null;
      }

      if (probeUrl !== null) {
        const result = spawnSync(
          'curl',
          ['-s', '--max-time', '2', probeUrl],
          { stdio: 'pipe', timeout: 2000 },
        );
        hardware.hasOllama = result.status === 0 && !result.error;
      } else {
        hardware.hasOllama = false;
      }

      // Cloud LLM is configured purely via env (LLM_CLOUD_MODEL or
      // LLM_PROVIDER=cloud). Without this, capability derivation in
      // heartbeat omits 'inference'/'llm' caps and the coordinator filters
      // research work-orders out of this node's pool.
      hardware.hasCloudLlm = !!(
        process.env.LLM_CLOUD_MODEL?.trim() ||
        process.env.LLM_PROVIDER?.trim().toLowerCase() === 'cloud'
      );

      if (!hardwareLoggedOnce) {
        logger.info(
          `[hardware] hasOllama=${hardware.hasOllama} (url=${ollamaUrl}) ` +
          `hasCloudLlm=${hardware.hasCloudLlm} ` +
          `gpuVramGb=${hardware.gpuVramGb} hardwareClass=${hardware.hardwareClass}`,
        );
        hardwareLoggedOnce = true;
      }
    }

    hardwareCache.set(cacheKey, hardware);
    return hardware;
  }

  /**
   * Get tier name
   */
  getTierName(tier: HardwareTier): string {
    const names = ['CPU-Only', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'];
    return names[tier] || 'Unknown';
  }

  /** @internal Build OS string — exported for testing */
  buildOsString(platform: string, release: string, arch: string, osType: string): string {
    if (platform === 'darwin') return `macOS ${release} (${arch})`;
    if (platform === 'linux') return `Linux ${release} (${arch})`;
    if (platform === 'win32') return `Windows ${release} (${arch})`;
    return `${osType} ${release} (${arch})`;
  }

  /** @internal Estimate Apple Silicon VRAM — exported for testing */
  estimateAppleSiliconVram(model: string): number {
    if (model.includes('M3 Ultra')) return 192;
    if (model.includes('M3 Max')) return 128;
    if (model.includes('M2 Ultra')) return 128;
    if (model.includes('M2 Max')) return 96;
    if (model.includes('M3 Pro')) return 48;
    if (model.includes('M2 Pro')) return 18;
    if (model.includes('M1 Ultra')) return 128;
    if (model.includes('M1 Max')) return 96;
    if (model.includes('M3') || model.includes('M2')) return 10;
    if (model.includes('M1')) return 7;
    return 0;
  }

  /** @internal Parse nvidia-smi CSV output — exported for testing */
  parseNvidiaSmiOutput(smiOutput: string): { name: string | null; vramGb: number } {
    const lines = smiOutput.trim().split('\n');

    const parts = lines[0]?.split(',')?.map((s) => s.trim()) || [];
    const name = parts[0] || 'NVIDIA GPU';
    const vramStr = parts[1] || '';

    const match = vramStr.match(/(\d+)\s*(GiB|MiB)/);
    if (!match) return { name, vramGb: 0 };

    const value = parseInt(match[1]);
    const unit = match[2];
    const vramGb = unit === 'GiB' ? value : Math.round(value / 1024);
    return { name, vramGb };
  }

  /**
   * Get system information
   */
  getSystemInfo(archOverride?: string): SystemInfo {
    const osPlatform = os.platform();
    const osRelease = os.release();
    const arch = archOverride || os.arch();
    const osString = this.buildOsString(osPlatform, osRelease, arch, os.type());

    const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';
    const cpuCores = os.cpus().length || 0;
    const memoryTotal = os.totalmem();

    let gpuType: string | null = null;
    let gpuVram = 0;

    try {
      if (arch === 'arm64' && osPlatform === 'darwin') {
        const model = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8' }).trim();
        gpuType = model;
        gpuVram = this.estimateAppleSiliconVram(model);
      } else if (arch === 'x86_64' || arch === 'x64') {
        // Same Windows-hang defense as detectHardware: skip the spawn
        // entirely when nvidia-smi is missing, and timeout-bound the
        // call when we do invoke it.
        if (isExecutableOnPath('nvidia-smi')) {
          try {
            const smiOutput = execSync(
              'nvidia-smi --query-gpu=name,memory.free --format=csv,noheader',
              {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: NVIDIA_SMI_TIMEOUT_MS,
              },
            );
            const parsed = this.parseNvidiaSmiOutput(smiOutput);
            gpuType = parsed.name;
            gpuVram = parsed.vramGb;
          } catch {
            // No NVIDIA GPU or spawn timeout
          }
        }
      }
    } catch (error) {
      // GPU detection failed
    }

    return {
      os: osString,
      cpu: {
        model: cpuModel,
        cores: cpuCores,
      },
      memory: {
        totalGb: Math.round(memoryTotal / (1024 ** 3)),
      },
      gpu: {
        type: gpuType,
        vramGb: gpuVram,
      },
    };
  }

  /**
   * Get compatible models based on available VRAM
   */
  getCompatibleModels(vramGb: number, allModels: ModelInfo[] = []): ModelInfo[] {
    if (!allModels || allModels.length === 0) {
      // Default model catalog (subset of full catalog)
      const defaultModels: ModelInfo[] = [
        { name: 'qwen2.5-3b', minVram: 4, recommendedTier: 2 },
        { name: 'qwen2.5-0.5b', minVram: 1, recommendedTier: 1 },
        { name: 'gemma-3-1b-web', minVram: 2, recommendedTier: 1 },
        { name: 'phi-2', minVram: 2, recommendedTier: 1 },
        { name: 'gemma-3-4b', minVram: 4, recommendedTier: 2 },
        { name: 'qwen2.5-coder-7b', minVram: 6, recommendedTier: 2 },
        { name: 'llama-3.1-8b-instruct', minVram: 10, recommendedTier: 3 },
        { name: 'gemma-3-12b', minVram: 10, recommendedTier: 3 },
        { name: 'gpt-oss-20b', minVram: 16, recommendedTier: 4 },
        { name: 'qwen2.5-coder-32b', minVram: 24, recommendedTier: 4 },
        { name: 'glm-4.7-flash', minVram: 24, recommendedTier: 5 },
        { name: 'qwen3-coder-30b-a3b', minVram: 24, recommendedTier: 5 },
      ];
      return defaultModels.filter((model) => model.minVram <= vramGb);
    }

    return allModels.filter((model) => model.minVram <= vramGb);
  }

  /**
   * Get recommended tier based on VRAM
   */
  getRecommendedTier(vramGb: number): number {
    if (vramGb >= 80) return 5;
    if (vramGb >= 48) return 5;
    if (vramGb >= 24) return 4;
    if (vramGb >= 16) return 4;
    if (vramGb >= 14) return 3;
    if (vramGb >= 10) return 3;
    if (vramGb >= 6) return 2;
    if (vramGb >= 1) return 1;
    return 0;
  }

  /**
   * Detect if this node can participate in CPU inference tasks.
   *
   * Requirements:
   * - At least 2 CPU cores
   * - At least 4 GB RAM
   *
   * Returns true when both conditions are met.
   */
  canInference(): boolean {
    const hw = this.detectHardware(true);
    return hw.cpuCores >= 2 && hw.ramGb >= 4;
  }

  /**
   * Detect if this node can run micro-transformer training.
   *
   * Requirements:
   * - python3 is available in PATH
   * - torch is importable (PyTorch installed)
   *
   * Returns true when both are satisfied.
   */
  canTrain(): boolean {
    // 1. Check python exists (venv first, else system python3)
    const pythonBin = resolvePython();
    const python = spawnSync(pythonBin, ['--version'], { stdio: 'pipe' });
    if (python.status !== 0 || python.error) {
      return false;
    }

    // 2. Check torch is importable
    const torchCheck = spawnSync(pythonBin, ['-c', 'import torch'], { stdio: 'pipe' });
    return torchCheck.status === 0 && !torchCheck.error;
  }

  /**
   * Detect if this node can participate in DiLoCo distributed training.
   *
   * Requirements:
   * - GPU or MPS available (gpuVramGb > 0)
   * - python3 available
   * - torch importable
   * - peft importable (LoRA adapters)
   *
   * Returns true when all conditions are met.
   */
  canDiLoCo(hardware?: Hardware): boolean {
    // Check GPU availability
    const hw = hardware ?? this.detectHardware(false);
    if (hw.gpuVramGb <= 0) {
      return false;
    }

    // Check python (venv first, else system python3)
    const pythonBin = resolvePython();
    const python = spawnSync(pythonBin, ['--version'], { stdio: 'pipe' });
    if (python.status !== 0 || python.error) {
      return false;
    }

    // Check torch
    const torchCheck = spawnSync(pythonBin, ['-c', 'import torch'], { stdio: 'pipe' });
    if (torchCheck.status !== 0 || torchCheck.error) {
      return false;
    }

    // Check peft
    const peftCheck = spawnSync(pythonBin, ['-c', 'import peft'], { stdio: 'pipe' });
    return peftCheck.status === 0 && !peftCheck.error;
  }

  /**
   * Build capabilities list from hardware.
   * Includes 'training' if Python + torch are available.
   * Includes 'diloco' and 'gpu' if canDiLoCo() returns true.
   */
  buildCapabilities(hardware: Hardware): string[] {
    const caps: string[] = [];
    if (hardware.cpuCores > 0) caps.push('cpu');
    if (hardware.gpuVramGb > 0) caps.push('gpu');
    if (this.canTrain()) {
      caps.push('training');
      // GPU + training → can do GPU-accelerated training (DiLoCo, fine-tuning)
      if (hardware.gpuVramGb > 0) caps.push('gpu_training');
    }
    if (this.canDiLoCo(hardware)) {
      if (!caps.includes('diloco')) caps.push('diloco');
      if (!caps.includes('gpu')) caps.push('gpu');
    }
    if (this.canInference()) {
      caps.push('cpu_inference');
      // GPU + inference → can serve GPU-accelerated inference
      if (hardware.gpuVramGb > 0) caps.push('gpu_inference');
    }
    return caps;
  }
}

// Backward-compatible standalone exports
export const detectAppleSilicon = (hardware: Hardware, model: string): void =>
  new HardwareHelper().detectAppleSilicon(hardware, model);
export const detectNvidiaGPU = (hardware: Hardware, smiOutput?: string): void =>
  new HardwareHelper().detectNvidiaGPU(hardware, smiOutput);
export const detectHardware = (cpuOnly?: boolean, archOverride?: string): Hardware =>
  new HardwareHelper().detectHardware(cpuOnly ?? false, archOverride);
export const getTierName = (tier: HardwareTier): string =>
  new HardwareHelper().getTierName(tier);
export const buildOsString = (platform: string, release: string, arch: string, osType: string): string =>
  new HardwareHelper().buildOsString(platform, release, arch, osType);
export const estimateAppleSiliconVram = (model: string): number =>
  new HardwareHelper().estimateAppleSiliconVram(model);
export const parseNvidiaSmiOutput = (smiOutput: string): { name: string | null; vramGb: number } =>
  new HardwareHelper().parseNvidiaSmiOutput(smiOutput);
export const getSystemInfo = (archOverride?: string): SystemInfo =>
  new HardwareHelper().getSystemInfo(archOverride);
export const getCompatibleModels = (vramGb: number, allModels?: ModelInfo[]): ModelInfo[] =>
  new HardwareHelper().getCompatibleModels(vramGb, allModels ?? []);
export const getRecommendedTier = (vramGb: number): number =>
  new HardwareHelper().getRecommendedTier(vramGb);
export const canTrain = (): boolean =>
  new HardwareHelper().canTrain();
export const canDiLoCo = (hardware?: Hardware): boolean =>
  new HardwareHelper().canDiLoCo(hardware);
export const canInference = (): boolean =>
  new HardwareHelper().canInference();
export const buildCapabilities = (hardware: Hardware): string[] =>
  new HardwareHelper().buildCapabilities(hardware);
