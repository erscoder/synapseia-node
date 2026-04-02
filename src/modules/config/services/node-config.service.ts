import { Injectable } from '@nestjs/common';
import { NodeConfigHelper, type Config } from '../config';

@Injectable()
export class NodeConfigService {
  constructor(private readonly nodeConfigHelper: NodeConfigHelper) {}

  load(): Config {
    return this.nodeConfigHelper.loadConfig();
  }

  save(config: Config): void {
    return this.nodeConfigHelper.saveConfig(config);
  }

  default(): Config {
    return this.nodeConfigHelper.defaultConfig();
  }

  validateCoordinatorUrl(url: string): boolean {
    return this.nodeConfigHelper.validateCoordinatorUrl(url);
  }

  validateModelFormat(model: string): boolean {
    return this.nodeConfigHelper.validateModelFormat(model);
  }

  isCloudModel(model: string): boolean {
    return this.nodeConfigHelper.isCloudModel(model);
  }
}
