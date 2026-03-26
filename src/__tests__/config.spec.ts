/**
 * Config module tests - ESM compatible
 * Uses isolated mocks to avoid file system state issues
 */

import { jest } from '@jest/globals';
import { describe, it, expect, beforeEach } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';

// Create isolated config paths for testing
const testConfigDir = join(tmpdir(), 'synapseia-test-' + Date.now());
const testConfigFile = join(testConfigDir, 'config.json');

// Mock before importing
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

jest.mock('os', () => ({
  homedir: () => testConfigDir,
}));

jest.mock('path', () => ({
  join: (...args: string[]) => args.join('/'),
}));

// Import after mocks
import { loadConfig, saveConfig, defaultConfig, validateCoordinatorUrl, validateModelFormat, isCloudModel, CONFIG_FILE, CONFIG_DIR } from '../modules/config/config';

describe('Config Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
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
      mockExistsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(mockExistsSync).toHaveBeenCalledWith(testConfigFile);
    });

    it('should load config from file when it exists', () => {
      const savedConfig = {
        coordinatorUrl: 'http://example.com:3001',
        defaultModel: 'ollama/llama2',
        llmUrl: 'https://api.custom.com',
        llmKey: 'secret-key',
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(savedConfig));

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://example.com:3001');
      expect(config.defaultModel).toBe('ollama/llama2');
      expect(config.llmUrl).toBe('https://api.custom.com');
      expect(config.llmKey).toBe('secret-key');
    });

    it('should return default config when file has invalid JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid json');

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://localhost:3701');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if it does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const config = defaultConfig();
      saveConfig(config);

      expect(mockMkdirSync).toHaveBeenCalledWith(testConfigDir, { recursive: true });
    });

    it('should not create directory if it already exists', () => {
      mockExistsSync.mockReturnValue(true);

      const config = defaultConfig();
      saveConfig(config);

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should write config to file with proper formatting', () => {
      mockExistsSync.mockReturnValue(true);

      const config = {
        coordinatorUrl: 'http://custom:3001',
        defaultModel: 'ollama/custom',
        llmUrl: 'https://api.example.com',
        llmKey: 'my-api-key',
      };
      saveConfig(config);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        testConfigFile,
        expect.stringContaining('"coordinatorUrl"'),
        expect.anything()
      );
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