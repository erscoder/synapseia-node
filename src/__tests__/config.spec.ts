/**
 * Config module tests - Uses real FS with SYNAPSEIA_HOME isolation
 * Avoids ESM mock issues by using real filesystem operations in a temp dir
 */

import { jest } from '@jest/globals';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

// Unique temp dir for this test run — set BEFORE any imports so CONFIG_DIR picks it up
const testConfigDir = join(tmpdir(), 'synapseia-test-' + Date.now());
process.env.SYNAPSEIA_HOME = testConfigDir;

// Now import the module (it will use SYNAPSEIA_HOME for CONFIG_DIR)
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  validateCoordinatorUrl,
  validateModelFormat,
  isCloudModel,
  CONFIG_FILE,
  CONFIG_DIR,
} from '../modules/config/config';

describe('Config Module', () => {
  beforeAll(() => {
    // Create temp config dir
    mkdirSync(testConfigDir, { recursive: true });
  });

  afterAll(() => {
    // Cleanup temp dir
    try { rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
    delete process.env.SYNAPSEIA_HOME;
  });

  beforeEach(() => {
    // Remove config file before each test for isolation
    try { rmSync(CONFIG_FILE); } catch {}
    // Clear env var overrides
    delete process.env.SYNAPSEIA_COORDINATOR_URL;
    delete process.env.LLM_CLOUD_MODEL;
    delete process.env.LLM_CLOUD_API_KEY;
    delete process.env.LLM_CLOUD_URL;
    delete process.env.LLM_CLOUD_BASE_URL;
  });

  describe('defaultConfig', () => {
    it('should return default configuration', () => {
      const config = defaultConfig();
      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
      expect(config.llmUrl).toBeUndefined();
      expect(config.llmKey).toBeUndefined();
      expect(config.wallet).toBeUndefined();
    });
  });

  describe('loadConfig', () => {
    it('should return default config when file does not exist', () => {
      // CONFIG_FILE deleted in beforeEach
      const config = loadConfig();
      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
    });

    it('should load config from file when it exists', () => {
      const savedConfig = {
        coordinatorUrl: 'http://example.com:3001',
        defaultModel: 'ollama/llama2',
        llmUrl: 'https://api.custom.com',
        llmKey: 'secret-key',
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(savedConfig));

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://example.com:3001');
      expect(config.defaultModel).toBe('ollama/llama2');
      expect(config.llmUrl).toBe('https://api.custom.com');
      expect(config.llmKey).toBe('secret-key');
    });

    it('should return default config when file has invalid JSON', () => {
      writeFileSync(CONFIG_FILE, 'invalid json{{{');

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if it does not exist', () => {
      const config = defaultConfig();
      saveConfig(config);
      expect(existsSync(CONFIG_FILE)).toBe(true);
    });

    it('should write config to file with proper formatting', () => {
      const config = {
        coordinatorUrl: 'http://custom:3001',
        defaultModel: 'ollama/custom',
        llmUrl: 'https://api.example.com',
        llmKey: 'my-api-key',
      };
      saveConfig(config);

      const loaded = loadConfig();
      expect(loaded.coordinatorUrl).toBe('http://custom:3001');
      expect(loaded.defaultModel).toBe('ollama/custom');
    });

    it('should round-trip config correctly', () => {
      const original = defaultConfig();
      original.coordinatorUrl = 'http://my-coordinator:9000';
      saveConfig(original);

      const loaded = loadConfig();
      expect(loaded.coordinatorUrl).toBe('http://my-coordinator:9000');
    });
  });

  describe('validateCoordinatorUrl', () => {
    it('should accept valid HTTP URLs', () => {
      expect(validateCoordinatorUrl('http://localhost:3000')).toBe(true);
      expect(validateCoordinatorUrl('https://example.com:8080')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(validateCoordinatorUrl('not-a-url')).toBe(false);
      expect(validateCoordinatorUrl('ftp://localhost')).toBe(false);
    });
  });

  describe('validateModelFormat', () => {
    it('should accept valid model formats', () => {
      expect(validateModelFormat('ollama/llama2')).toBe(true);
      expect(validateModelFormat('openai/gpt-4')).toBe(true);
      expect(validateModelFormat('anthropic/claude-3')).toBe(true);
    });

    it('should reject invalid model formats', () => {
      expect(validateModelFormat('invalid')).toBe(false);
      expect(validateModelFormat('')).toBe(false);
    });
  });

  describe('isCloudModel', () => {
    it('should identify cloud models', () => {
      expect(isCloudModel('openai-compat/gpt-4')).toBe(true);
      expect(isCloudModel('anthropic/claude-3')).toBe(true);
      expect(isCloudModel('kimi/m2.5')).toBe(true);
      expect(isCloudModel('minimax/m2.5')).toBe(true);
    });

    it('should identify local models', () => {
      expect(isCloudModel('ollama/llama2')).toBe(false);
      expect(isCloudModel('local-model')).toBe(false);
    });
  });
});
