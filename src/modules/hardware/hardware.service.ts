import { Injectable } from '@nestjs/common';
import {
  detectHardware,
  getSystemInfo,
  getCompatibleModels,
  getRecommendedTier,
  getTierName,
  type Hardware,
  type SystemInfo,
  type HardwareTier,
  type ModelInfo,
} from '../../hardware.js';

@Injectable()
export class HardwareService {
  detect(cpuOnly = false, archOverride?: string): Hardware {
    return detectHardware(cpuOnly, archOverride);
  }

  getSystemInfo(archOverride?: string): SystemInfo {
    return getSystemInfo(archOverride);
  }

  getCompatibleModels(vramGb: number, allModels: ModelInfo[] = []): ModelInfo[] {
    return getCompatibleModels(vramGb, allModels);
  }

  getRecommendedTier(vramGb: number): number {
    return getRecommendedTier(vramGb);
  }

  getTierName(tier: HardwareTier): string {
    return getTierName(tier);
  }
}
