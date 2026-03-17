import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

export function defaultConfig(): Config {
  return {
    coordinatorUrl: 'http://localhost:3001',
    defaultModel: 'ollama/qwen2.5:0.5b',
  };
}

export function loadConfig(): Config {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return defaultConfig();
    }
  }
  return defaultConfig();
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function validateCoordinatorUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export function validateModelFormat(model: string): boolean {
  // Format: provider/model-name or provider/model:name
  const parts = model.split('/');
  if (parts.length !== 2) return false;
  
  const [provider, modelName] = parts;
  if (!provider || !modelName) return false;
  
  // Provider must be alphanumeric
  if (!/^[a-zA-Z0-9-]+$/.test(provider)) return false;
  
  return true;
}

export function isCloudModel(model: string): boolean {
  return model.startsWith('openai-compat/') || 
         model.startsWith('anthropic/') || 
         model.startsWith('kimi/') || 
         model.startsWith('minimax/');
}
