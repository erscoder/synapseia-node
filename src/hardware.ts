/**
 * Hardware detection and tier calculation
 */

import * as os from 'os';
import { execSync } from 'child_process';

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

/**
 * Detect hardware capabilities
 */
function detectAppleSilicon(hardware: Hardware, model: string): void {
  if (model.includes('M3 Ultra')) hardware.tier = 5;
  else if (model.includes('M3 Max') || model.includes('M3 Pro')) hardware.tier = 4;
  else if (model.includes('M2 Ultra')) hardware.tier = 3;
  else if (model.includes('M2 Max')) hardware.tier = 3;
  else if (model.includes('M2 Pro') || model.includes('M1 Ultra')) hardware.tier = 2;
  else if (model.includes('M1 Max')) hardware.tier = 2;
  else if (model.includes('M3') || model.includes('M2') || model.includes('M1')) hardware.tier = 1;

  // Apple Silicon GPU VRAM estimates
  if (model.includes('Ultra')) hardware.gpuVramGb = hardware.tier === 5 ? 192 : 128;
  else if (model.includes('Max')) hardware.gpuVramGb = hardware.tier === 5 ? 128 : 96;
  else if (model.includes('Pro')) hardware.gpuVramGb = hardware.tier >= 3 ? 48 : 18;
  else hardware.gpuVramGb = hardware.tier === 1 ? 10 : 7;
}

function detectNvidiaGPU(hardware: Hardware): void {
  const smiOutput = execSync('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits', { encoding: 'utf-8' });
  
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

export function detectHardware(cpuOnly = false): Hardware {
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
      const arch = os.arch();
      if (arch === 'arm64') {
        const model = execSync('sysctl -n machdep.cpu.brand_string').toString().trim();
        detectAppleSilicon(hardware, model);
      } else if (arch === 'x86') {
        detectNvidiaGPU(hardware);
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
export function getTierName(tier: HardwareTier): string {
  const names = ['CPU-Only', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'];
  return names[tier] || 'Unknown';
}
