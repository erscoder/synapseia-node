import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Injectable } from '@nestjs/common';

// Config file path
export const CONFIG_DIR = join(homedir(), '.synapse');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface Config {
  coordinatorUrl: string;
  defaultModel: string;
  llmUrl?: string;
  llmKey?: string;
  wallet?: string;
}

@Injectable()
export class NodeConfigHelper {
  defaultConfig(): Config {
    return {
      coordinatorUrl: 'http://localhost:3001',
      defaultModel: 'ollama/qwen2.5:0.5b',
    };
  }

  loadConfig(): Config {
    if (existsSync(CONFIG_FILE)) {
      try {
        return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      } catch {
        return this.defaultConfig();
      }
    }
    return this.defaultConfig();
  }

  saveConfig(config: Config): void {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }

  validateCoordinatorUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
  }

  validateModelFormat(model: string): boolean {
    // Format: provider/model-name or provider/model:name
    const parts = model.split('/');
    if (parts.length !== 2) return false;

    const [provider, modelName] = parts;
    if (!provider || !modelName) return false;

    // Provider must be alphanumeric
    if (!/^[a-zA-Z0-9-]+$/.test(provider)) return false;

    return true;
  }

  isCloudModel(model: string): boolean {
    return model.startsWith('openai-compat/') ||
           model.startsWith('anthropic/') ||
           model.startsWith('kimi/') ||
           model.startsWith('minimax/');
  }
}

// Backward-compatible standalone exports
export const defaultConfig = (...args: Parameters<NodeConfigHelper['defaultConfig']>) =>
  new NodeConfigHelper().defaultConfig(...args);

export const loadConfig = (...args: Parameters<NodeConfigHelper['loadConfig']>) =>
  new NodeConfigHelper().loadConfig(...args);

export const saveConfig = (...args: Parameters<NodeConfigHelper['saveConfig']>) =>
  new NodeConfigHelper().saveConfig(...args);

export const validateCoordinatorUrl = (...args: Parameters<NodeConfigHelper['validateCoordinatorUrl']>) =>
  new NodeConfigHelper().validateCoordinatorUrl(...args);

export const validateModelFormat = (...args: Parameters<NodeConfigHelper['validateModelFormat']>) =>
  new NodeConfigHelper().validateModelFormat(...args);

export const isCloudModel = (...args: Parameters<NodeConfigHelper['isCloudModel']>) =>
  new NodeConfigHelper().isCloudModel(...args);
