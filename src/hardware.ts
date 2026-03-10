import { execSync } from 'child_process';
import axios from 'axios';
import os from 'node:os';

export interface HardwareInfo {
  cpuCores: number;
  ramGb: number;
  gpuVramGb: number; // 0 si no hay GPU
  tier: 0 | 1 | 2 | 3 | 4 | 5;
  hasOllama: boolean;
}

export async function detectHardware(): Promise<HardwareInfo> {
  // CPU cores
  const cpuCores = os.cpus().length;

  // RAM in GB
  const ramGb = os.totalmem() / (1024 * 1024 * 1024);

  // GPU VRAM detection (nvidia-smi)
  let gpuVramGb = 0;
  try {
    const output = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const vramMb = parseInt(output.trim());
    gpuVramGb = vramMb / 1024;
  } catch {
    // No NVIDIA GPU detected
    gpuVramGb = 0;
  }

  // Tier calculation
  let tier: 0 | 1 | 2 | 3 | 4 | 5 = 0;
  if (gpuVramGb === 0) {
    tier = 0; // CPU only
  } else if (gpuVramGb >= 8 && gpuVramGb < 16) {
    tier = 1;
  } else if (gpuVramGb >= 16 && gpuVramGb < 24) {
    tier = 2;
  } else if (gpuVramGb >= 24 && gpuVramGb < 32) {
    tier = 3;
  } else if (gpuVramGb >= 32 && gpuVramGb < 80) {
    tier = 4;
  } else if (gpuVramGb >= 80) {
    tier = 5;
  }

  // Ollama detection
  let hasOllama = false;
  try {
    await axios.get('http://localhost:11434/api/tags', { timeout: 2000 });
    hasOllama = true;
  } catch {
    hasOllama = false;
  }

  return {
    cpuCores,
    ramGb: Math.round(ramGb * 100) / 100,
    gpuVramGb: Math.round(gpuVramGb * 100) / 100,
    tier,
    hasOllama,
  };
}
