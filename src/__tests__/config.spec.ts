import { loadConfig, saveConfig, defaultConfig, validateCoordinatorUrl, validateModelFormat, isCloudModel, CONFIG_FILE, CONFIG_DIR } from '../modules/config/helpers/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Mock fs module
jest.mock('fs');

const mockedExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockedReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockedWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const mockedMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;

describe('Config Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('defaultConfig', () => {
    it('should return default configuration', () => {
      const config = defaultConfig();

      expect(config.coordinatorUrl).toBe('http://localhost:3001');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
      expect(config.llmUrl).toBeUndefined();
      expect(config.llmKey).toBeUndefined();
      expect(config.wallet).toBeUndefined();
    });
  });

  describe('loadConfig', () => {
    it('should return default config when file does not exist', () => {
      mockedExistsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://localhost:3001');
      expect(existsSync).toHaveBeenCalledWith(CONFIG_FILE);
    });

    it('should load config from file when it exists', () => {
      const savedConfig = {
        coordinatorUrl: 'http://example.com:3001',
        defaultModel: 'ollama/llama2',
        llmUrl: 'https://api.custom.com',
        llmKey: 'secret-key',
      };
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(savedConfig));

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://example.com:3001');
      expect(config.defaultModel).toBe('ollama/llama2');
      expect(config.llmUrl).toBe('https://api.custom.com');
      expect(config.llmKey).toBe('secret-key');
    });

    it('should return default config when file has invalid JSON', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('invalid json');

      const config = loadConfig();

      expect(config.coordinatorUrl).toBe('http://localhost:3001');
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if it does not exist', () => {
      mockedExistsSync.mockReturnValue(false);

      const config = defaultConfig();
      saveConfig(config);

      expect(mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    });

    it('should not create directory if it already exists', () => {
      mockedExistsSync.mockReturnValue(true);

      const config = defaultConfig();
      saveConfig(config);

      expect(mkdirSync).not.toHaveBeenCalled();
    });

    it('should write config to file with proper formatting', () => {
      mockedExistsSync.mockReturnValue(true);

      const config = {
        coordinatorUrl: 'http://custom:3001',
        defaultModel: 'ollama/custom',
        llmUrl: 'https://api.example.com',
        llmKey: 'my-api-key',
      };
      saveConfig(config);

      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        JSON.stringify(config, null, 2)
      );
    });
  });

  describe('validateCoordinatorUrl', () => {
    it('should return true for valid http URLs', () => {
      expect(validateCoordinatorUrl('http://localhost:3001')).toBe(true);
      expect(validateCoordinatorUrl('http://example.com')).toBe(true);
    });

    it('should return true for valid https URLs', () => {
      expect(validateCoordinatorUrl('https://api.example.com')).toBe(true);
      expect(validateCoordinatorUrl('https://localhost:3001')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(validateCoordinatorUrl('ftp://example.com')).toBe(false);
      expect(validateCoordinatorUrl('localhost:3001')).toBe(false);
      expect(validateCoordinatorUrl('')).toBe(false);
      expect(validateCoordinatorUrl('ws://example.com')).toBe(false);
    });
  });

  describe('validateModelFormat', () => {
    it('should return true for valid model formats', () => {
      expect(validateModelFormat('ollama/qwen2.5:0.5b')).toBe(true);
      expect(validateModelFormat('openai-compat/asi1-mini')).toBe(true);
      expect(validateModelFormat('anthropic/claude-3')).toBe(true);
    });

    it('should return false for invalid model formats', () => {
      expect(validateModelFormat('invalid')).toBe(false);
      expect(validateModelFormat('missing-slash')).toBe(false);
      expect(validateModelFormat('/no-provider')).toBe(false);
      expect(validateModelFormat('provider/')).toBe(false);
      expect(validateModelFormat('')).toBe(false);
    });

    it('should return false for providers with special characters', () => {
      expect(validateModelFormat('ollama!/model')).toBe(false);
      expect(validateModelFormat('ollama space/model')).toBe(false);
    });
  });

  describe('isCloudModel', () => {
    it('should return true for openai-compat models', () => {
      expect(isCloudModel('openai-compat/asi1-mini')).toBe(true);
      expect(isCloudModel('openai-compat/custom')).toBe(true);
    });

    it('should return true for anthropic models', () => {
      expect(isCloudModel('anthropic/claude-3-opus')).toBe(true);
      expect(isCloudModel('anthropic/claude-3-sonnet')).toBe(true);
    });

    it('should return true for kimi models', () => {
      expect(isCloudModel('kimi/kimi-k2.5')).toBe(true);
    });

    it('should return true for minimax models', () => {
      expect(isCloudModel('minimax/MiniMax-M2.5')).toBe(true);
    });

    it('should return false for local ollama models', () => {
      expect(isCloudModel('ollama/qwen2.5:0.5b')).toBe(false);
      expect(isCloudModel('ollama/llama2')).toBe(false);
    });

    it('should return false for other local models', () => {
      expect(isCloudModel('local/model')).toBe(false);
      expect(isCloudModel('unknown/model')).toBe(false);
    });
  });
});
