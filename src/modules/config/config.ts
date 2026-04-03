import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Injectable } from '@nestjs/common';

type AgentMode = 'langgraph' | 'legacy';

export type AgentModeConfig = { mode: AgentMode };

export const CONFIG_DIR = process.env.SYNAPSEIA_HOME ?? join(homedir(), '.synapseia');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface Config {
  coordinatorUrl: string;
  defaultModel: string;
  name?: string;
  lat?: number;
  lng?: number;
  llmUrl?: string;
  llmKey?: string;
  wallet?: string;
  inferenceEnabled?: boolean;
  inferenceModels?: string[];
}

@Injectable()
export class NodeConfigHelper {
  defaultConfig(): Config {
    return {
      coordinatorUrl: 'http://localhost:3701',
      defaultModel: process.env.LLM_CLOUD_MODEL ?? 'ollama/qwen2.5:0.5b',
      llmUrl: process.env.LLM_CLOUD_BASE_URL,
      llmKey: process.env.LLM_CLOUD_API_KEY,
    };
  }

  loadConfig(): Config {
    if (existsSync(CONFIG_FILE)) {
      try {
        return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Config;
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
    const parts = model.split('/');
    if (parts.length !== 2) return false;
    const [provider, modelName] = parts;
    if (!provider || !modelName) return false;
    if (!/^[a-zA-Z0-9-]+$/.test(provider)) return false;
    return true;
  }

  isCloudModel(model: string): boolean {
    return model.startsWith('openai-compat/') ||
           model.startsWith('anthropic/') ||
           model.startsWith('kimi/') ||
           model.startsWith('minimax/');
  }

  getAgentMode(): AgentMode {
    const mode = process.env.AGENT_MODE?.toLowerCase();
    return mode === 'langgraph' ? 'langgraph' : 'legacy';
  }

  isLangGraphMode(): boolean {
    return this.getAgentMode() === 'langgraph';
  }
}
