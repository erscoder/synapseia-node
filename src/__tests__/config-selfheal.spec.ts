/**
 * config.json self-heal + forensics tests.
 *
 * Uses real FS with SYNAPSEIA_HOME isolation (same pattern as
 * config.spec.ts). Drives the missing / corrupt / has-bak / no-bak
 * permutations so a lost or corrupt operator config is RECOVERED from
 * the sibling `.bak` instead of being silently reset to qwen0.5b
 * defaults — and so every boot leaves a forensic breadcrumb (existence
 * + mtime + size, NEVER the file contents which may hold an API key).
 */

// MUST be first: sets SYNAPSEIA_HOME before config.ts is evaluated so
// CONFIG_DIR points at an isolated temp dir, not the real ~/.synapseia.
import { SELFHEAL_HOME } from '../test-support/selfheal-home';
import { jest } from '@jest/globals';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { join } from 'path';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import logger from '../utils/logger';
import {
  NodeConfigHelper,
  CONFIG_DIR,
  CONFIG_FILE,
  CONFIG_BAK_FILE,
  FALLBACK_DEFAULT_MODEL,
} from '../modules/config/config';

const testConfigDir = SELFHEAL_HOME;

/**
 * Captures every line logger emits (info + warn) so a test can assert
 * WHAT was logged without asserting the human-readable formatting. The
 * tap receives the same string args the console saw.
 */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const infoSpy = jest.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const warnSpy = jest.spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return {
    lines,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

/** A non-default operator config worth backing up. */
const operatorConfig = {
  defaultModel: 'ollama/qwen2.5-coder:7b',
  llmKey: 'sk-operator-secret-do-not-log',
  name: 'kike-node',
};

describe('Config self-heal + forensics', () => {
  let helper: NodeConfigHelper;

  beforeAll(() => {
    mkdirSync(testConfigDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(testConfigDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    delete process.env.SYNAPSEIA_HOME;
  });

  beforeEach(() => {
    // Wipe every sibling artifact so each permutation starts clean.
    for (const f of [CONFIG_FILE, CONFIG_BAK_FILE]) {
      try {
        rmSync(f);
      } catch {
        /* not present */
      }
    }
    if (existsSync(CONFIG_DIR)) {
      for (const entry of readdirSync(CONFIG_DIR)) {
        if (entry.startsWith('config.json.corrupt-')) {
          try {
            rmSync(join(CONFIG_DIR, entry));
          } catch {
            /* ignore */
          }
        }
      }
    }
    delete process.env.LLM_CLOUD_MODEL;
    delete process.env.LLM_CLOUD_API_KEY;
    helper = new NodeConfigHelper();
  });

  // ── (a) save writes .bak ──────────────────────────────────────────
  describe('saveConfig backup', () => {
    it('writes a sibling .bak with the same content for a non-default config', () => {
      helper.saveConfig(operatorConfig as any);

      expect(existsSync(CONFIG_BAK_FILE)).toBe(true);
      const main = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      const bak = JSON.parse(readFileSync(CONFIG_BAK_FILE, 'utf-8'));
      expect(bak).toEqual(main);
      expect(bak.defaultModel).toBe('ollama/qwen2.5-coder:7b');
    });

    // ── (f) .bak not clobbered by a defaults-only save ───────────────
    it('does NOT clobber a good .bak when saving a defaults-only config', () => {
      // Seed a real operator .bak.
      helper.saveConfig(operatorConfig as any);
      const goodBak = readFileSync(CONFIG_BAK_FILE, 'utf-8');

      // Now save a defaults-only config (the qwen0.5b fallback shape).
      helper.saveConfig({ defaultModel: FALLBACK_DEFAULT_MODEL } as any);

      // Main file reflects the defaults save, but the .bak is preserved.
      const main = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      expect(main.defaultModel).toBe(FALLBACK_DEFAULT_MODEL);
      expect(readFileSync(CONFIG_BAK_FILE, 'utf-8')).toBe(goodBak);
    });
  });

  // ── (b) missing config + valid .bak → restored + warn ─────────────
  describe('self-heal: missing config.json', () => {
    it('restores config.json from a valid .bak and warns', () => {
      const cap = captureLogs();
      try {
        // Seed a .bak only (config.json absent).
        helper.saveConfig(operatorConfig as any);
        rmSync(CONFIG_FILE);
        expect(existsSync(CONFIG_FILE)).toBe(false);
        expect(existsSync(CONFIG_BAK_FILE)).toBe(true);

        const cfg = helper.loadConfig();

        // Operator config recovered (NOT the qwen0.5b fallback).
        expect(cfg.defaultModel).toBe('ollama/qwen2.5-coder:7b');
        expect(cfg.llmKey).toBe('sk-operator-secret-do-not-log');
        // config.json physically restored on disk.
        expect(existsSync(CONFIG_FILE)).toBe(true);
        const restored = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        expect(restored.defaultModel).toBe('ollama/qwen2.5-coder:7b');
        // Loud breadcrumb mentioning the recovery.
        const blob = cap.lines.join('\n');
        expect(blob).toMatch(/restored.*\.bak|MISSING.*restored/i);
      } finally {
        cap.restore();
      }
    });
  });

  // ── (c) corrupt config + valid .bak → restored + .corrupt kept ────
  describe('self-heal: corrupt config.json with valid .bak', () => {
    it('restores from .bak and preserves the corrupt file as .corrupt-<ts>', () => {
      const cap = captureLogs();
      try {
        helper.saveConfig(operatorConfig as any);
        // Corrupt the main file but keep the good .bak.
        writeFileSync(CONFIG_FILE, '{ this is not json ]]');

        const cfg = helper.loadConfig();

        expect(cfg.defaultModel).toBe('ollama/qwen2.5-coder:7b');
        expect(cfg.llmKey).toBe('sk-operator-secret-do-not-log');
        // A forensic copy of the corrupt bytes was preserved.
        const corruptCopies = readdirSync(CONFIG_DIR).filter((f) =>
          f.startsWith('config.json.corrupt-'),
        );
        expect(corruptCopies.length).toBe(1);
        expect(readFileSync(join(CONFIG_DIR, corruptCopies[0]), 'utf-8')).toBe(
          '{ this is not json ]]',
        );
        // Main file is now the restored good config.
        const restored = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        expect(restored.defaultModel).toBe('ollama/qwen2.5-coder:7b');
        expect(cap.lines.join('\n')).toMatch(/corrupt/i);
      } finally {
        cap.restore();
      }
    });
  });

  // ── (d) corrupt config + no/invalid .bak → defaults + .corrupt ────
  describe('self-heal: corrupt config.json with no usable .bak', () => {
    it('falls back to defaults, preserves corrupt as .corrupt, does NOT overwrite it with defaults', () => {
      const cap = captureLogs();
      try {
        // Corrupt main, no .bak present.
        writeFileSync(CONFIG_FILE, '}}corrupt-no-bak{{');
        expect(existsSync(CONFIG_BAK_FILE)).toBe(false);

        const cfg = helper.loadConfig();

        // Default fallback model (current behavior preserved).
        expect(cfg.defaultModel).toBe(FALLBACK_DEFAULT_MODEL);
        // Corrupt bytes preserved for forensics...
        const corruptCopies = readdirSync(CONFIG_DIR).filter((f) =>
          f.startsWith('config.json.corrupt-'),
        );
        expect(corruptCopies.length).toBe(1);
        expect(readFileSync(join(CONFIG_DIR, corruptCopies[0]), 'utf-8')).toBe(
          '}}corrupt-no-bak{{',
        );
        // ...and the corrupt file is NOT silently overwritten with defaults
        // on this load (a defaults-only config must never clobber forensics).
        if (existsSync(CONFIG_FILE)) {
          const onDisk = readFileSync(CONFIG_FILE, 'utf-8');
          expect(onDisk).not.toContain(FALLBACK_DEFAULT_MODEL);
        }
        expect(cap.lines.join('\n')).toMatch(/corrupt/i);
      } finally {
        cap.restore();
      }
    });

    it('treats an unparseable .bak as no .bak (falls to defaults, keeps corrupt)', () => {
      writeFileSync(CONFIG_FILE, 'corrupt-main');
      writeFileSync(CONFIG_BAK_FILE, 'corrupt-bak-too');

      const cfg = helper.loadConfig();
      expect(cfg.defaultModel).toBe(FALLBACK_DEFAULT_MODEL);
      const corruptCopies = readdirSync(CONFIG_DIR).filter((f) =>
        f.startsWith('config.json.corrupt-'),
      );
      expect(corruptCopies.length).toBe(1);
    });

    it('does NOT overwrite the corrupt file even when a default-config migration is pending', () => {
      // Guard for the skipPersist path: a corrupt config.json with no .bak
      // falls to defaults. If LLM_CLOUD_MODEL pins a slug that triggers an
      // on-load migration, the post-migration save must STILL not clobber
      // the corrupt bytes on this boot — they are the operator's last
      // on-disk state and are already preserved as `.corrupt-<ts>`.
      process.env.LLM_CLOUD_MODEL = 'kimi/kimi-k2.6'; // migrates -> moonshot/*
      writeFileSync(CONFIG_FILE, '<<<corrupt-with-pending-migration>>>');
      expect(existsSync(CONFIG_BAK_FILE)).toBe(false);

      const cfg = helper.loadConfig();

      // Migration applied in-memory (operator sees a coherent runtime config)...
      expect(cfg.defaultModel).toBe('moonshot/kimi-k2.6');
      // ...but the on-disk corrupt file is untouched (NOT replaced by the
      // migrated defaults) and no .bak was written from defaults.
      expect(readFileSync(CONFIG_FILE, 'utf-8')).toBe('<<<corrupt-with-pending-migration>>>');
      expect(existsSync(CONFIG_BAK_FILE)).toBe(false);
      const corruptCopies = readdirSync(CONFIG_DIR).filter((f) =>
        f.startsWith('config.json.corrupt-'),
      );
      expect(corruptCopies.length).toBe(1);

      delete process.env.LLM_CLOUD_MODEL;
    });
  });

  // ── (e) missing + no .bak → defaults + warn ───────────────────────
  describe('self-heal: missing config.json with no .bak', () => {
    it('returns defaults and warns that config was absent with no backup', () => {
      const cap = captureLogs();
      try {
        expect(existsSync(CONFIG_FILE)).toBe(false);
        expect(existsSync(CONFIG_BAK_FILE)).toBe(false);

        const cfg = helper.loadConfig();

        expect(cfg.defaultModel).toBe(FALLBACK_DEFAULT_MODEL);
        expect(cap.lines.join('\n')).toMatch(/absent|no backup|no \.bak/i);
      } finally {
        cap.restore();
      }
    });
  });

  // ── (g) boot forensics log fires with existence + mtime, never contents
  describe('boot forensics breadcrumb', () => {
    it('logs config.json existence + mtime + size on every load, NEVER its contents', () => {
      const cap = captureLogs();
      try {
        helper.saveConfig(operatorConfig as any);
        cap.lines.length = 0; // ignore save-time logs; focus on load.

        helper.loadConfig();

        const blob = cap.lines.join('\n');
        // Breadcrumb present: existence + size, with an mtime stamp.
        expect(blob).toMatch(/config\.json/i);
        expect(blob).toMatch(/exists|present/i);
        expect(blob).toMatch(/bytes|size/i);
        // The secret in the operator config must NEVER reach the log.
        expect(blob).not.toContain('sk-operator-secret-do-not-log');
        expect(blob).not.toContain('"llmKey"');
      } finally {
        cap.restore();
      }
    });

    it('logs the absent state when config.json is missing (no contents to leak)', () => {
      const cap = captureLogs();
      try {
        helper.loadConfig();
        const blob = cap.lines.join('\n');
        expect(blob).toMatch(/config\.json/i);
        expect(blob).toMatch(/missing|absent|not.*present/i);
      } finally {
        cap.restore();
      }
    });
  });
});
