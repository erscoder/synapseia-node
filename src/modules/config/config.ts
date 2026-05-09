import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Injectable } from '@nestjs/common';
import {
  CLOUD_PROVIDERS_BY_ID,
  FALLBACK_MODEL_SLUG,
  resolveSlug,
  topSlugFor,
  type CloudProviderId,
} from '../llm/providers';
import { getCoordinatorUrl, getCoordinatorWsUrl } from '../../constants/coordinator';
import logger from '../../utils/logger';

type AgentMode = 'langgraph' | 'legacy';

export type AgentModeConfig = { mode: AgentMode };

export const CONFIG_DIR = process.env.SYNAPSEIA_HOME ?? join(homedir(), '.synapseia');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface Config {
  /**
   * @deprecated Coordinator URL is no longer user-configurable. The CLI
   * and desktop UI no longer expose flags / inputs to set this value.
   * Existing on-disk values are tolerated by the schema for back-compat
   * (so legacy config.json files still parse) but the value is ignored
   * at runtime — `getCoordinatorUrl()` always resolves through
   * `process.env.COORDINATOR_URL` → `OFFICIAL_COORDINATOR_URL`.
   */
  coordinatorUrl?: string;
  /**
   * @deprecated See `coordinatorUrl`. Use `process.env.COORDINATOR_WS_URL`
   * to point a node at a non-default WebSocket endpoint; the on-disk value
   * is ignored at runtime.
   */
  coordinatorWsUrl?: string;
  defaultModel: string;
  name?: string;
  lat?: number;
  lng?: number;
  /**
   * @deprecated Endpoints are hardcoded per provider. The field is read
   * for backward-compat (so old config.json files still parse) but its
   * value is ignored at request time. The migration on load also strips
   * it from disk on the next save.
   */
  llmUrl?: string;
  llmKey?: string;
  wallet?: string;
  inferenceEnabled?: boolean;
  inferenceModels?: string[];
}

/**
 * Migrate a legacy `provider/model` slug to one that the current
 * whitelist accepts. Returns the new slug and a human-readable reason
 * when a rewrite happened, or null when the slug is already valid.
 *
 * Rules:
 *   - `kimi/X`               → `moonshot/X` (rebrand of internal id)
 *   - `openai-compat/*`      → fallback `anthropic/claude-sonnet-4-6`
 *   - `custom`               → fallback
 *   - whitelisted provider but unknown model id → top tier of that provider
 *   - completely unknown provider → fallback
 */
export function migrateModelSlug(slug: string): { slug: string; reason: string } | null {
  if (!slug) return { slug: FALLBACK_MODEL_SLUG, reason: 'empty model — using default' };

  // Already valid?
  if (resolveSlug(slug)) return null;

  // Rebrand: kimi/* -> moonshot/*
  if (slug.startsWith('kimi/')) {
    const next = `moonshot/${slug.slice('kimi/'.length)}`;
    if (resolveSlug(next)) return { slug: next, reason: `kimi/* renamed to moonshot/*` };
    return { slug: topSlugFor('moonshot'), reason: `kimi/* deprecated; using top moonshot tier` };
  }

  // Hard-fallback: openai-compat/*, custom
  if (slug.startsWith('openai-compat/') || slug === 'custom') {
    return { slug: FALLBACK_MODEL_SLUG, reason: `${slug} no longer supported; falling back` };
  }

  // ollama / synapseia accept any model id — already handled by resolveSlug
  // returning non-null. Reaching here means resolveSlug() rejected it,
  // which only happens for malformed strings.
  if (slug.startsWith('ollama/') || slug.startsWith('synapseia/')) {
    // resolveSlug returns a value for these even when the modelId isn't
    // in the curated list, so this branch is unreachable in practice;
    // keeping it explicit guards against future regressions.
    return null;
  }

  // Whitelisted provider but off-list model id: tolerate it. Vendors
  // release new models faster than we can update the table and the
  // runtime parseModel() in llm-provider.ts accepts off-list models on
  // whitelisted providers. Rewriting here would silently demote a
  // deliberate override (e.g. operator pinning openai/gpt-7-turbo)
  // back to gpt-5 on every boot.
  const slash = slug.indexOf('/');
  if (slash > 0) {
    const provider = slug.slice(0, slash);
    if (CLOUD_PROVIDERS_BY_ID.has(provider as CloudProviderId)) {
      return null;
    }
  }

  return { slug: FALLBACK_MODEL_SLUG, reason: 'unknown provider; using default' };
}

@Injectable()
export class NodeConfigHelper {
  defaultConfig(): Config {
    return {
      coordinatorUrl: getCoordinatorUrl(),
      coordinatorWsUrl: getCoordinatorWsUrl(),
      defaultModel: process.env.LLM_CLOUD_MODEL ?? 'ollama/qwen2.5:0.5b',
      llmKey: process.env.LLM_CLOUD_API_KEY,
    };
  }

  loadConfig(): Config {
    let cfg: Config;
    if (existsSync(CONFIG_FILE)) {
      try {
        cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Config;
      } catch {
        cfg = this.defaultConfig();
      }
    } else {
      cfg = this.defaultConfig();
    }

    const migrated = this.applyMigrations(cfg);
    if (migrated.changed) {
      // Persist the rewritten slug + drop deprecated fields so the
      // operator only sees the WARN once instead of every boot.
      try {
        this.saveConfig(migrated.config);
      } catch (err) {
        logger.warn(`[config] failed to persist migrated config: ${(err as Error).message}`);
      }
    }
    // Force-resolve coordinator URLs through the env-var-or-constant
    // chain. Any legacy on-disk value is ignored — downstream callers
    // that still read `config.coordinatorUrl` / `config.coordinatorWsUrl`
    // see the resolved value instead of an undefined / stale one.
    migrated.config.coordinatorUrl = getCoordinatorUrl();
    migrated.config.coordinatorWsUrl = getCoordinatorWsUrl();
    return migrated.config;
  }

  /**
   * Run all on-load migrations: rewrite obsolete provider slugs, strip
   * the deprecated `llmUrl` field, and emit a single WARN per rewrite.
   * Returns the resulting Config plus a `changed` flag so callers can
   * decide whether to persist.
   */
  private applyMigrations(input: Config): { config: Config; changed: boolean } {
    let changed = false;
    const next: Config = { ...input };

    const migration = migrateModelSlug(next.defaultModel);
    if (migration) {
      // Sanitise the slug we log: keep at most a 'provider/<id>' shape so
      // an operator who accidentally typed a secret into defaultModel
      // doesn't see it printed back. Real model ids are short tokens; if
      // someone wrote 60+ chars they almost certainly pasted something
      // they shouldn't have.
      const safeSlug = next.defaultModel.length > 80
        ? `${next.defaultModel.slice(0, 40)}…<truncated>`
        : next.defaultModel;
      logger.warn(
        `[config] migrated defaultModel '${safeSlug}' → '${migration.slug}' (${migration.reason})`,
      );
      next.defaultModel = migration.slug;
      changed = true;
    }

    if (next.llmUrl !== undefined) {
      // Same defensive redaction — strip querystring (where keys hide).
      const safeUrl = String(next.llmUrl).split('?')[0];
      logger.warn(
        `[config] dropping deprecated 'llmUrl' (${safeUrl}) — endpoints are hardcoded per provider`,
      );
      delete next.llmUrl;
      changed = true;
    }

    return { config: next, changed };
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
    const slash = model.indexOf('/');
    if (slash <= 0) return false;
    const provider = model.slice(0, slash);
    return CLOUD_PROVIDERS_BY_ID.has(provider as CloudProviderId);
  }

  getAgentMode(): AgentMode {
    const mode = process.env.AGENT_MODE?.toLowerCase();
    return mode === 'langgraph' ? 'langgraph' : 'legacy';
  }

  isLangGraphMode(): boolean {
    return this.getAgentMode() === 'langgraph';
  }
}
