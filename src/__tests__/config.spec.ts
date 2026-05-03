/**
 * Config module tests - Uses real FS with SYNAPSEIA_HOME isolation
 */

import { jest } from '@jest/globals';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { NodeConfigHelper, CONFIG_FILE, CONFIG_DIR } from '../modules/config/config';

const testConfigDir = join(tmpdir(), 'synapseia-test-' + Date.now());
process.env.SYNAPSEIA_HOME = testConfigDir;

describe('Config Module', () => {
  let helper: NodeConfigHelper;

  beforeAll(() => {
    mkdirSync(testConfigDir, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
    delete process.env.SYNAPSEIA_HOME;
  });

  beforeEach(() => {
    try { rmSync(CONFIG_FILE); } catch {}
    delete process.env.SYNAPSEIA_COORDINATOR_URL;
    delete process.env.LLM_CLOUD_MODEL;
    delete process.env.LLM_CLOUD_API_KEY;
    delete process.env.LLM_CLOUD_URL;
    delete process.env.LLM_CLOUD_BASE_URL;
    helper = new NodeConfigHelper();
  });

  describe('defaultConfig', () => {
    it('should return default configuration', () => {
      const config = helper.defaultConfig();
      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
      expect(config.llmUrl).toBeUndefined();
      expect(config.llmKey).toBeUndefined();
    });
  });

  describe('loadConfig', () => {
    it('should return default config when file does not exist', () => {
      const config = helper.loadConfig();
      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
    });

    it('should load config from file when it exists (and migrate deprecated llmUrl away)', () => {
      const savedConfig = {
        coordinatorUrl: 'http://example.com:3001',
        defaultModel: 'ollama/llama2',
        llmUrl: 'https://api.custom.com',
        llmKey: 'secret-key',
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(savedConfig));

      const config = helper.loadConfig();

      expect(config.coordinatorUrl).toBe('http://example.com:3001');
      expect(config.defaultModel).toBe('ollama/llama2');
      // llmUrl is now deprecated and stripped on load; the value lands in
      // a one-shot WARN log but is not surfaced to callers.
      expect(config.llmUrl).toBeUndefined();
      expect(config.llmKey).toBe('secret-key');
    });

    it('migrates kimi/* slugs to moonshot/* on load', () => {
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'kimi/kimi-k2.6' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('moonshot/kimi-k2.6');
    });

    it('falls back to anthropic/sonnet-4.6 for openai-compat/* slugs', () => {
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'openai-compat/asi1' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('anthropic/claude-sonnet-4-6');
    });

    it('tolerates off-list cloud model ids on whitelisted providers (no silent rewrite)', () => {
      // Vendors release new models faster than we update providers.ts.
      // If the operator deliberately pinned an off-list model id under
      // a whitelisted provider, migration must NOT rewrite it back to
      // the top tier — runtime parseModel() accepts these.
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'openai/gpt-99-experimental' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('openai/gpt-99-experimental');
    });

    it('should return default config when file has invalid JSON', () => {
      writeFileSync(CONFIG_FILE, 'invalid json{{{');
      const config = helper.loadConfig();
      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if it does not exist', () => {
      const config = helper.defaultConfig();
      helper.saveConfig(config);
      expect(existsSync(CONFIG_FILE)).toBe(true);
    });

    it('should write config to file with proper formatting', () => {
      const config = {
        coordinatorUrl: 'http://custom:3001',
        defaultModel: 'ollama/custom',
        llmUrl: 'https://api.example.com',
        llmKey: 'my-api-key',
      };
      helper.saveConfig(config);

      const loaded = helper.loadConfig();
      expect(loaded.coordinatorUrl).toBe('http://custom:3001');
      expect(loaded.defaultModel).toBe('ollama/custom');
    });

    it('should round-trip config correctly', () => {
      const original = helper.defaultConfig();
      original.coordinatorUrl = 'http://my-coordinator:9000';
      helper.saveConfig(original);

      const loaded = helper.loadConfig();
      expect(loaded.coordinatorUrl).toBe('http://my-coordinator:9000');
    });
  });

  describe('validateCoordinatorUrl', () => {
    it('should accept valid HTTP URLs', () => {
      expect(helper.validateCoordinatorUrl('http://localhost:3000')).toBe(true);
      expect(helper.validateCoordinatorUrl('https://example.com:8080')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(helper.validateCoordinatorUrl('not-a-url')).toBe(false);
      expect(helper.validateCoordinatorUrl('ftp://localhost')).toBe(false);
    });
  });

  describe('validateModelFormat', () => {
    it('should accept valid model formats', () => {
      expect(helper.validateModelFormat('ollama/llama2')).toBe(true);
      expect(helper.validateModelFormat('openai/gpt-4')).toBe(true);
      expect(helper.validateModelFormat('anthropic/claude-3')).toBe(true);
    });

    it('should reject invalid model formats', () => {
      expect(helper.validateModelFormat('invalid')).toBe(false);
      expect(helper.validateModelFormat('')).toBe(false);
      expect(helper.validateModelFormat('ollama/')).toBe(false);
      expect(helper.validateModelFormat('/llama2')).toBe(false);
    });
  });

  describe('isCloudModel', () => {
    it('should identify cloud models against the current whitelist', () => {
      expect(helper.isCloudModel('openai/gpt-5')).toBe(true);
      expect(helper.isCloudModel('anthropic/claude-sonnet-4-6')).toBe(true);
      expect(helper.isCloudModel('google/gemini-2.5-pro')).toBe(true);
      expect(helper.isCloudModel('moonshot/kimi-k2.6')).toBe(true);
      expect(helper.isCloudModel('minimax/MiniMax-M2.7')).toBe(true);
      expect(helper.isCloudModel('zhipu/glm-4.6')).toBe(true);
      expect(helper.isCloudModel('ollama/qwen2.5:0.5b')).toBe(false);
      // Legacy slugs are not cloud — they no longer have a routable adapter.
      expect(helper.isCloudModel('kimi/k2.5')).toBe(false);
      expect(helper.isCloudModel('openai-compat/gpt-4')).toBe(false);
    });
  });
});
