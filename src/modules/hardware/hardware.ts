/**
 * Hardware detection and tier calculation
 */

import * as os from 'os';
import { execSync } from 'child_process';
import { Injectable } from '@nestjs/common';

import type { ModelCategory } from '../model/model-catalog.js';

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
  tier: number;
  hasOllama: boolean;
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
    if (model.includes('M3 Ultra')) hardware.tier = 5;
    else if (model.includes('M3 Max') || model.includes('M3 Pro')) hardware.tier = 4;
    else if (model.includes('M2 Ultra')) hardware.tier = 3;
    else if (model.includes('M2 Max')) hardware.tier = 3;
    else if (model.includes('M2 Pro') || model.includes('M1 Ultra')) hardware.tier = 2;
    else if (model.includes('M1 Max')) hardware.tier = 2;
    else if (model.includes('M3') || model.includes('M2') || model.includes('M1')) hardware.tier = 1;

    // Apple Silicon GPU VRAM estimates
    if (model.includes('Ultra')) hardware.gpuVramGb = hardware.tier === 5 ? 192 : 128;
    else if (model.includes('Max')) hardware.gpuVramGb = 96; // Max models always set tier to 4 or 3 before this, so tier===5 never happens
    else if (model.includes('Pro')) hardware.gpuVramGb = hardware.tier >= 3 ? 48 : 18;
    else hardware.gpuVramGb = hardware.tier === 1 ? 10 : 7;
  }

  /** @internal exported for testing */
  detectNvidiaGPU(hardware: Hardware, smiOutput?: string): void {
    if (!smiOutput) {
      smiOutput = execSync('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits', { encoding: 'utf-8' });
    }

    if (smiOutput.includes('GiB')) {
      const match = smiOutput.match(/(\d+)\s*GiB/);
      if (match) hardware.gpuVramGb = parseInt(match[1]);
    } else if (smiOutput.includes('MiB')) {
      const match = smiOutput.match(/(\d+)\s*MiB/);
      if (match) hardware.gpuVramGb = Math.round(parseInt(match[1]) / 1024);
    }

    // Determine tier based on VRAM
    if (hardware.gpuVramGb >= 80) hardware.tier = 5;
    else if (hardware.gpuVramGb >= 64) hardware.tier = 5;
    else if (hardware.tier < 5 && hardware.gpuVramGb >= 24) hardware.tier = 4;
    else if (hardware.tier < 4 && hardware.gpuVramGb >= 14) hardware.tier = 3;
    else if (hardware.tier < 3 && hardware.gpuVramGb >= 10) hardware.tier = 2;
    else if (hardware.tier < 2 && hardware.gpuVramGb >= 6) hardware.tier = 1;
  }

  detectHardware(cpuOnly = false, archOverride?: string): Hardware {
    const hardware: Hardware = {
      cpuCores: os.cpus().length || 2,
      ramGb: Math.round(os.totalmem() / (1024 ** 3)),
      gpuVramGb: 0,
      tier: 0,
      hasOllama: false,
    };

    if (!cpuOnly) {
      // Detect GPU
      try {
        const arch = archOverride || os.arch();
        if (arch === 'arm64') {
          const model = execSync('sysctl -n machdep.cpu.brand_string').toString().trim();
          this.detectAppleSilicon(hardware, model);
        } else if (arch === 'x86') {
          this.detectNvidiaGPU(hardware);
        }
      } catch {
        // nvidia-smi not available or no GPU
      }

      // Check for Ollama
      try {
        execSync('curl -s http://localhost:11434/api/tags', { stdio: 'pipe', timeout: 1000 });
        hardware.hasOllama = true;
      } catch {
        hardware.hasOllama = false;
      }
    }

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
        try {
          const smiOutput = execSync('nvidia-smi --query-gpu=name,memory.free --format=csv,noheader', { encoding: 'utf-8' });
          const parsed = this.parseNvidiaSmiOutput(smiOutput);
          gpuType = parsed.name;
          gpuVram = parsed.vramGb;
        } catch {
          // No NVIDIA GPU
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
