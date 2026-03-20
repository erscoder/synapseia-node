import { Injectable } from '@nestjs/common';
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  validateCoordinatorUrl,
  validateModelFormat,
  isCloudModel,
  type Config,
} from '../../config.js';

@Injectable()
export class NodeConfigService {
  load(): Config {
    return loadConfig();
  }

  save(config: Config): void {
    return saveConfig(config);
  }

  default(): Config {
    return defaultConfig();
  }

  validateCoordinatorUrl(url: string): boolean {
    return validateCoordinatorUrl(url);
  }

  validateModelFormat(model: string): boolean {
    return validateModelFormat(model);
  }

  isCloudModel(model: string): boolean {
    return isCloudModel(model);
  }
}
