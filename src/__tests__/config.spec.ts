/**
 * Config module tests - Uses real FS with SYNAPSEIA_HOME isolation
 */

import { jest } from '@jest/globals';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import {
  NodeConfigHelper,
  CONFIG_FILE,
  CONFIG_DIR,
  MODEL_SLUG_REGEX,
  DEFAULT_SOLANA_RPC_URL,
  resolveSolanaRpcUrl,
} from '../modules/config/config';
import { OFFICIAL_COORDINATOR_URL, OFFICIAL_COORDINATOR_WS_URL } from '../constants/coordinator';

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
    delete process.env.COORDINATOR_URL;
    delete process.env.COORDINATOR_WS_URL;
    delete process.env.LLM_CLOUD_MODEL;
    delete process.env.LLM_CLOUD_API_KEY;
    delete process.env.LLM_CLOUD_URL;
    delete process.env.LLM_CLOUD_BASE_URL;
    delete process.env.SOLANA_RPC_URL;
    helper = new NodeConfigHelper();
  });

  describe('defaultConfig', () => {
    it('should return default configuration with resolved coordinator URLs', () => {
      // coordinatorUrl is deprecated as a user-facing knob, but the
      // factory still populates it with the resolved env-var-or-constant
      // value so that downstream callers reading `config.coordinatorUrl`
      // see a usable URL instead of `undefined`.
      const config = helper.defaultConfig();
      expect(config.coordinatorUrl).toBe(OFFICIAL_COORDINATOR_URL);
      expect(config.coordinatorWsUrl).toBe(OFFICIAL_COORDINATOR_WS_URL);
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
      expect(config.llmUrl).toBeUndefined();
      expect(config.llmKey).toBeUndefined();
    });
  });

  describe('loadConfig', () => {
    it('should return default config when file does not exist', () => {
      const config = helper.loadConfig();
      expect(config.coordinatorUrl).toBe(OFFICIAL_COORDINATOR_URL);
      expect(config.coordinatorWsUrl).toBe(OFFICIAL_COORDINATOR_WS_URL);
      expect(config.defaultModel).toBe('ollama/qwen2.5:0.5b');
    });

    it('ignores legacy on-disk coordinatorUrl and resolves through env-var-or-constant', () => {
      // BLOCKER fix: pre-refactor on-disk values must NOT leak into the
      // runtime config. Downstream callers still read
      // `config.coordinatorUrl` directly; the loader force-overrides
      // the field with the resolved value so those callers see the
      // env var (or the OFFICIAL constant) rather than a stale URL.
      const savedConfig = {
        coordinatorUrl: 'https://something-old.example.com',
        coordinatorWsUrl: 'wss://something-old.example.com',
        defaultModel: 'ollama/llama2',
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(savedConfig));

      const config = helper.loadConfig();

      expect(config.coordinatorUrl).toBe(OFFICIAL_COORDINATOR_URL);
      expect(config.coordinatorUrl).not.toBe('https://something-old.example.com');
      expect(config.coordinatorWsUrl).toBe(OFFICIAL_COORDINATOR_WS_URL);
      expect(config.coordinatorWsUrl).not.toBe('wss://something-old.example.com');
    });

    it('honours COORDINATOR_URL env var over the on-disk value', () => {
      process.env.COORDINATOR_URL = 'https://env.example.test:9001';
      process.env.COORDINATOR_WS_URL = 'wss://env.example.test:9002';
      const savedConfig = {
        coordinatorUrl: 'https://stale-disk.example.com',
        defaultModel: 'ollama/llama2',
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(savedConfig));

      const config = helper.loadConfig();

      expect(config.coordinatorUrl).toBe('https://env.example.test:9001');
      expect(config.coordinatorWsUrl).toBe('wss://env.example.test:9002');
    });

    it('migrates deprecated llmUrl away on load', () => {
      const savedConfig = {
        coordinatorUrl: 'http://example.com:3001',
        defaultModel: 'ollama/llama2',
        llmUrl: 'https://api.custom.com',
        llmKey: 'secret-key',
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(savedConfig));

      const config = helper.loadConfig();

      expect(config.defaultModel).toBe('ollama/llama2');
      // llmUrl is deprecated and stripped on load; the value lands in
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

    it('auto-prefixes unprefixed ollama-style slugs (0.8.44 wizard regression defense)', () => {
      // 0.8.44 wizard wrote `qwen2.5-coder:14b` straight into config
      // without the `ollama/` provider prefix. Migration must rescue
      // these as ollama models, not fall back to the cloud default
      // (which then refuses to boot without --llm-key).
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'qwen2.5-coder:14b' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/qwen2.5-coder:14b');
    });

    it('rewrites unprefixed dash-form catalog names to the canonical ollama tag', () => {
      // 0.8.44 wizard regression: catalog UI label uses dash-form
      // (`qwen2.5-coder-14b`) but the Ollama daemon only resolves the
      // colon-form tag (`qwen2.5-coder:14b`). Migration must look the
      // entry up in MODEL_CATALOG and rewrite to `getOllamaTag(entry)`
      // — otherwise runtime sends the dash-form to Ollama and gets
      // "model 'qwen2.5-coder-14b' not found", which we observed live
      // on operator pods running 0.8.45.
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'qwen2.5-coder-14b' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/qwen2.5-coder:14b');
    });

    it('rewrites unprefixed qwen2.5-coder-7b to canonical ollama tag', () => {
      // Same path as above, asserted on the slug from the operator
      // pod log that motivated this fix (`qwen2.5-coder-7b`).
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'qwen2.5-coder-7b' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/qwen2.5-coder:7b');
    });

    it('falls back to literal ollama/<slug> when catalog entry has no ollamaTag override', () => {
      // `home-3b-v3` exists in MODEL_CATALOG with no `ollamaTag` field,
      // so getOllamaTag(entry) === entry.name and we keep the literal
      // ollama/home-3b-v3 (no colon rewrite). Same behaviour as pre-fix.
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'home-3b-v3' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/home-3b-v3');
    });

    it('falls back to literal ollama/<slug> when slug is not in the catalog', () => {
      // Operator pulled a custom model not curated in MODEL_CATALOG.
      // Migration must still rescue it as an ollama-prefixed slug
      // (runtime parseModel accepts off-list ollama ids).
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'custom-pulled-model' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/custom-pulled-model');
    });

    it('reseats 0.8.45-migrated ollama/<dash-name> to canonical ollama tag', () => {
      // Operators that ran 0.8.45 already have configs like
      // `ollama/qwen2.5-coder-7b` (dash-form post-slash) on disk because the
      // 0.8.45 migration prefixed the bare wizard slug verbatim. resolveSlug
      // accepts any ollama modelId so the previous migration loop never
      // rewrote it, and the runtime call to Ollama then failed with
      // "model 'qwen2.5-coder-7b' not found". 0.8.46 catches this on boot.
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'ollama/qwen2.5-coder-7b' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/qwen2.5-coder:7b');
    });

    it('leaves ollama/<canonical-tag> untouched (already correct)', () => {
      // Operator that re-ran the wizard on 0.8.45+ has the colon-form tag.
      // Migration must NOT rewrite this — it would loop forever.
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'ollama/qwen2.5-coder:7b' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/qwen2.5-coder:7b');
    });

    it('leaves ollama/<unknown-pulled-model> untouched (custom pulls outside catalog)', () => {
      // A custom model the operator pulled themselves — not in MODEL_CATALOG.
      // No ollamaTag override exists, so migration must NOT touch it.
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ coordinatorUrl: 'http://x:1', defaultModel: 'ollama/some-custom-pulled-thing' }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe('ollama/some-custom-pulled-thing');
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
      expect(config.coordinatorUrl).toBe(OFFICIAL_COORDINATOR_URL);
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
      // coordinatorUrl on disk is now ignored; loader resolves through
      // the env-var-or-constant chain.
      expect(loaded.coordinatorUrl).toBe(OFFICIAL_COORDINATOR_URL);
      expect(loaded.defaultModel).toBe('ollama/custom');
    });

    it('persists non-coordinator fields across save/load round-trip', () => {
      const original = helper.defaultConfig();
      original.defaultModel = 'ollama/round-trip-model';
      original.llmKey = 'round-trip-key';
      helper.saveConfig(original);

      const loaded = helper.loadConfig();
      expect(loaded.defaultModel).toBe('ollama/round-trip-model');
      expect(loaded.llmKey).toBe('round-trip-key');
      // Coordinator URLs always resolve to the official constant when
      // no env var is set, regardless of what was persisted.
      expect(loaded.coordinatorUrl).toBe(OFFICIAL_COORDINATOR_URL);
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
      expect(helper.validateModelFormat('openai/gpt-4o')).toBe(true);
      expect(helper.validateModelFormat('anthropic/claude-3')).toBe(true);
    });

    it('should accept NVIDIA NIM multi-slash model IDs', () => {
      // NVIDIA NIM uses vendor-namespaced model IDs (provider/vendor/model).
      // The slug parser splits on the first slash, so additional slashes
      // belong to the modelId namespace, not the provider.
      expect(helper.validateModelFormat('nvidia/meta/llama-3.3-70b-instruct')).toBe(true);
      expect(helper.validateModelFormat('nvidia/nvidia/nemotron-3-super-120b-a12b')).toBe(true);
    });

    it('should reject invalid model formats', () => {
      expect(helper.validateModelFormat('invalid')).toBe(false);
      expect(helper.validateModelFormat('')).toBe(false);
      expect(helper.validateModelFormat('ollama/')).toBe(false);
      expect(helper.validateModelFormat('nvidia/')).toBe(false);
      expect(helper.validateModelFormat('/llama2')).toBe(false);
    });
  });

  describe('MODEL_SLUG_REGEX (CLI --set-model contract)', () => {
    // This regex is the single source of truth for the CLI --set-model
    // validation and ConfigService.validateModelFormat. Asserted directly
    // so the CLI flag stays in lockstep with the service layer.
    it('accepts canonical single-slash slugs', () => {
      expect(MODEL_SLUG_REGEX.test('openai/gpt-4o')).toBe(true);
      expect(MODEL_SLUG_REGEX.test('ollama/qwen2.5:0.5b')).toBe(true);
      expect(MODEL_SLUG_REGEX.test('anthropic/claude-sonnet-4-6')).toBe(true);
    });

    it('accepts NVIDIA NIM multi-slash model IDs', () => {
      expect(MODEL_SLUG_REGEX.test('nvidia/meta/llama-3.3-70b-instruct')).toBe(true);
      expect(MODEL_SLUG_REGEX.test('nvidia/nvidia/nemotron-3-super-120b-a12b')).toBe(true);
    });

    it('rejects malformed slugs (fail-closed)', () => {
      expect(MODEL_SLUG_REGEX.test('')).toBe(false);
      expect(MODEL_SLUG_REGEX.test('invalid')).toBe(false);
      expect(MODEL_SLUG_REGEX.test('nvidia/')).toBe(false);
      expect(MODEL_SLUG_REGEX.test('/llama2')).toBe(false);
      expect(MODEL_SLUG_REGEX.test('nvidia space/model')).toBe(false);
    });
  });

  describe('resolveSolanaRpcUrl', () => {
    it('returns env var when set, ignoring config and default', () => {
      process.env.SOLANA_RPC_URL = 'https://helius.test/env';
      const url = resolveSolanaRpcUrl({
        defaultModel: 'ollama/x',
        rpcUrl: 'https://quicknode.test/cfg',
      });
      expect(url).toBe('https://helius.test/env');
    });

    it('returns config.rpcUrl when env is unset', () => {
      const url = resolveSolanaRpcUrl({
        defaultModel: 'ollama/x',
        rpcUrl: 'https://quicknode.test/cfg',
      });
      expect(url).toBe('https://quicknode.test/cfg');
    });

    it('returns the devnet default when both env and config are unset', () => {
      const url = resolveSolanaRpcUrl({ defaultModel: 'ollama/x' });
      expect(url).toBe(DEFAULT_SOLANA_RPC_URL);
      expect(url).toBe('https://api.devnet.solana.com');
    });

    it('returns the devnet default when config is null', () => {
      const url = resolveSolanaRpcUrl(null);
      expect(url).toBe(DEFAULT_SOLANA_RPC_URL);
    });

    it('trims whitespace from env and config values', () => {
      process.env.SOLANA_RPC_URL = '  https://helius.test/env  ';
      expect(resolveSolanaRpcUrl(null)).toBe('https://helius.test/env');
      delete process.env.SOLANA_RPC_URL;

      const url = resolveSolanaRpcUrl({
        defaultModel: 'ollama/x',
        rpcUrl: '   https://quicknode.test/cfg   ',
      });
      expect(url).toBe('https://quicknode.test/cfg');
    });

    it('treats empty/whitespace env and config as unset (falls through to default)', () => {
      process.env.SOLANA_RPC_URL = '   ';
      const url = resolveSolanaRpcUrl({
        defaultModel: 'ollama/x',
        rpcUrl: '   ',
      });
      expect(url).toBe(DEFAULT_SOLANA_RPC_URL);
    });
  });

  describe('rpcUrl persistence', () => {
    it('loadConfig preserves rpcUrl from disk', () => {
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          coordinatorUrl: 'http://x:1',
          defaultModel: 'ollama/llama2',
          rpcUrl: 'https://helius.example/rpc',
        }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.rpcUrl).toBe('https://helius.example/rpc');
    });

    it('saveConfig persists rpcUrl when present', () => {
      const cfg = helper.defaultConfig();
      cfg.rpcUrl = 'https://quicknode.example/rpc';
      helper.saveConfig(cfg);

      const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      expect(onDisk.rpcUrl).toBe('https://quicknode.example/rpc');
    });

    it('saveConfig omits rpcUrl key when undefined (back-compat with existing configs)', () => {
      const cfg = helper.defaultConfig();
      expect(cfg.rpcUrl).toBeUndefined();
      helper.saveConfig(cfg);

      const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      expect(Object.prototype.hasOwnProperty.call(onDisk, 'rpcUrl')).toBe(false);
    });

    it('defaultConfig does not set rpcUrl (resolver decides at runtime)', () => {
      const cfg = helper.defaultConfig();
      expect(cfg.rpcUrl).toBeUndefined();
    });

    it('loadConfig tolerates legacy configs without rpcUrl (no error, undefined field)', () => {
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          coordinatorUrl: 'http://x:1',
          defaultModel: 'ollama/llama2',
        }),
      );
      const cfg = helper.loadConfig();
      expect(cfg.rpcUrl).toBeUndefined();
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
