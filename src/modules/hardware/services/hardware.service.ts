import { Injectable } from '@nestjs/common';
import {
  HardwareHelper,
  type Hardware,
  type SystemInfo,
  type HardwareTier,
  type ModelInfo,
} from '../hardware';

@Injectable()
export class HardwareService {
  constructor(private readonly hardwareHelper: HardwareHelper) {}

  detect(cpuOnly = false, archOverride?: string): Hardware {
    return this.hardwareHelper.detectHardware(cpuOnly, archOverride);
  }

  getSystemInfo(archOverride?: string): SystemInfo {
    return this.hardwareHelper.getSystemInfo(archOverride);
  }

  getCompatibleModels(vramGb: number, allModels: ModelInfo[] = []): ModelInfo[] {
    return this.hardwareHelper.getCompatibleModels(vramGb, allModels);
  }

  getRecommendedTier(vramGb: number): number {
    return this.hardwareHelper.getRecommendedTier(vramGb);
  }

  getTierName(tier: HardwareTier): string {
    return this.hardwareHelper.getTierName(tier);
  }
}
