import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from 'fs';
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
import { MODEL_CATALOG, getOllamaTag } from '../model/model-catalog';
import { getCoordinatorUrl, getCoordinatorWsUrl } from '../../constants/coordinator';
import logger from '../../utils/logger';

type AgentMode = 'langgraph' | 'legacy';

export type AgentModeConfig = { mode: AgentMode };

export const CONFIG_DIR = process.env.SYNAPSEIA_HOME ?? join(homedir(), '.synapseia');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Always-on sibling backup of {@link CONFIG_FILE}. Every successful save
 * of a *non-default* config mirrors here, and {@link NodeConfigHelper.loadConfig}
 * restores from it when the live config.json goes missing or corrupt.
 * This is the recovery net for the recurring "config.json got reset to
 * qwen0.5b defaults" incident — the operator's real model / API key /
 * wallet survive a lost main file instead of being silently dropped.
 */
export const CONFIG_BAK_FILE = join(CONFIG_DIR, 'config.json.bak');

/**
 * The defaults-only fallback model — the slug {@link NodeConfigHelper.defaultConfig}
 * lands on when neither a persisted config nor `LLM_CLOUD_MODEL` pin a
 * real model. Exported so the backup heuristic can recognise a
 * "defaults-only" config and refuse to clobber a good `.bak` with it,
 * and so tests can assert the fallback without hard-coding the literal.
 */
export const FALLBACK_DEFAULT_MODEL = 'ollama/qwen2.5:0.5b';

/**
 * Forensic snapshot of a config file's on-disk state. Deliberately
 * carries NO file contents — config.json may hold an LLM API key, so the
 * breadcrumb is limited to existence + mtime + byte size, which is enough
 * to correlate "config went missing" with a preceding event (update,
 * restart, crash) in the log stream without ever leaking a secret.
 */
export interface ConfigFileForensics {
  exists: boolean;
  /** ISO-8601 mtime, or `null` when the file is absent / unreadable. */
  mtime: string | null;
  /** Size in bytes, or `null` when the file is absent / unreadable. */
  size: number | null;
}

/**
 * Read existence + mtime + size for a path WITHOUT reading its contents.
 * Pure (no logging, no mutation) so callers can drive it from tests and
 * compose it into the boot breadcrumb. Never throws: an unreadable file
 * (race with deletion, permissions) collapses to the "absent" shape.
 */
export function statForensics(path: string): ConfigFileForensics {
  try {
    const st = statSync(path);
    return { exists: true, mtime: st.mtime.toISOString(), size: st.size };
  } catch {
    return { exists: false, mtime: null, size: null };
  }
}

/**
 * Decide whether a config is worth mirroring to `config.json.bak`.
 *
 * Rule: back up only configs that carry genuine operator state, i.e. a
 * `defaultModel` other than {@link FALLBACK_DEFAULT_MODEL}, OR any of the
 * operator-set fields (`llmKey`, `wallet`, `name`, `rpcUrl`,
 * non-empty `inferenceModels`, `inferenceEnabled`, `lat`/`lng`).
 *
 * Rationale: the `.bak` is the recovery net. If we let a defaults-only
 * save (the qwen0.5b fallback the node writes after a reset) overwrite a
 * good `.bak`, the self-heal would later "restore" defaults — defeating
 * the whole guard. So a defaults-only config is explicitly NOT worth
 * backing up; it can never clobber a real backup.
 */
export function isWorthBackingUp(config: Config): boolean {
  if (config.defaultModel && config.defaultModel !== FALLBACK_DEFAULT_MODEL) {
    return true;
  }
  return Boolean(
    config.llmKey ||
      config.wallet ||
      config.name ||
      config.rpcUrl ||
      (config.inferenceModels && config.inferenceModels.length > 0) ||
      config.inferenceEnabled ||
      typeof config.lat === 'number' ||
      typeof config.lng === 'number',
  );
}

/**
 * Default Solana RPC URL used by node-side on-chain modules when neither
 * the `SOLANA_RPC_URL` env var nor `config.rpcUrl` are set.
 *
 * Synapseia is still operating on devnet, so the safe operator default
 * has to point at the public devnet RPC. When the project migrates to
 * mainnet the constant will flip and operators that pinned their own
 * RPC via `syn config --set-rpc-url <url>` will be unaffected.
 *
 * TODO: migrate the other on-chain modules (`activation.ts`,
 * `solana-balance.ts`, `staking.ts`, `rewards.ts`, `rewards-vault-cli.ts`,
 * `chain-info-lightweight.ts`) to use `resolveSolanaRpcUrl` instead of
 * their own hardcoded devnet URL — out of scope for this PR.
 */
export const DEFAULT_SOLANA_RPC_URL = 'https://api.devnet.solana.com';

/**
 * Resolve the Solana RPC URL the node should talk to. Priority (high → low):
 *   1. `process.env.SOLANA_RPC_URL`  — escape hatch for CI / ops
 *   2. `config.rpcUrl`               — persisted operator preference (Helius, QuickNode, …)
 *   3. `DEFAULT_SOLANA_RPC_URL`      — Synapseia devnet
 *
 * Whitespace is trimmed and empty strings are treated as "unset" so a
 * blank value in either source falls through to the next.
 */
export function resolveSolanaRpcUrl(config: Config | null = null): string {
  const envUrl = process.env.SOLANA_RPC_URL?.trim();
  if (envUrl) return envUrl;
  const cfgUrl = config?.rpcUrl?.trim();
  if (cfgUrl) return cfgUrl;
  return DEFAULT_SOLANA_RPC_URL;
}

/**
 * Canonical regex for `provider/modelId` slugs accepted by the CLI
 * `--set-model` flag and `ConfigService.validateModelFormat`.
 *
 * Provider charset is restricted to `[a-zA-Z0-9_-]`. The modelId part
 * is intentionally permissive (`[\w.:/\-]+`) because some vendors
 * (e.g. NVIDIA NIM) use multi-segment namespaced IDs like
 * `meta/llama-3.3-70b-instruct` or `nvidia/nemotron-3-super-120b-a12b`.
 * The runtime slug parser (`resolveSlug`, `parseSlug`, `migrateModelSlug`)
 * already splits on the FIRST `/`, so additional slashes belong to the
 * modelId namespace, not the provider.
 *
 * Still fail-closed for: empty input, missing slash, empty provider,
 * empty modelId, characters outside the allowed charset.
 */
export const MODEL_SLUG_REGEX = /^[a-zA-Z0-9_-]+\/[\w.:/\-]+$/;

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
  /**
   * Operator-pinned Solana RPC URL (Helius, QuickNode, private node, …).
   * Resolved at runtime via `resolveSolanaRpcUrl` with the priority chain
   * env > config > default. Optional and omitted on disk when unset so
   * existing configs round-trip cleanly.
   */
  rpcUrl?: string;
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

  // Pre-emptive rewrite for the 0.8.45 dash-form leak.
  //
  // A config saved by the 0.8.45 migration looks like `ollama/qwen2.5-coder-7b`:
  // already provider-prefixed but using the catalog dash-form `name` instead
  // of the canonical Ollama tag. `resolveSlug` accepts any Ollama modelId so
  // the early-return below would otherwise leave the slug untouched, and the
  // runtime call to the Ollama daemon would surface as "model 'X' not found".
  // Detect that exact shape and reseat to the canonical `ollamaTag` before
  // the early-return so the slug heals on next boot.
  if (slug.startsWith('ollama/')) {
    const tail = slug.slice('ollama/'.length);
    const catalogMatch = MODEL_CATALOG.find((m) => m.name === tail);
    if (catalogMatch?.ollamaTag && catalogMatch.ollamaTag !== tail) {
      return {
        slug: `ollama/${catalogMatch.ollamaTag}`,
        reason: 'rewriting 0.8.45-migrated dash-form to canonical ollama tag',
      };
    }
  }

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

  // Unprefixed slug (no slash): assume the operator (or an older
  // wizard) meant an Ollama model. Auto-prefix `ollama/` before the
  // hard fallback to cloud — falling back to a cloud provider when the
  // operator picked a local model is catastrophic UX: every boot would
  // then refuse to start with "requires --llm-key". Defense against
  // the 0.8.44 wizard regression that wrote bare catalog names.
  //
  // When the slug matches a MODEL_CATALOG entry whose UI-label (`name`,
  // dash-form) differs from the canonical Ollama tag (`ollamaTag`,
  // colon-form, e.g. `qwen2.5-coder-7b` → `qwen2.5-coder:7b`),
  // rewrite to the canonical tag so the runtime call to Ollama hits a
  // real model. The wizard wrote `name` verbatim and the 0.8.45 migration
  // previously prefixed it as `ollama/<dash-name>`, which Ollama daemons
  // do not recognise and surfaces as "model 'X' not found".
  if (slash < 0) {
    const catalogMatch = MODEL_CATALOG.find((m) => m.name === slug);
    const ollamaSlug = catalogMatch ? getOllamaTag(catalogMatch) : slug;
    const candidate = `ollama/${ollamaSlug}`;
    if (resolveSlug(candidate)) {
      const reason =
        catalogMatch && catalogMatch.ollamaTag
          ? `unprefixed catalog name; rewriting to canonical ollama tag`
          : `unprefixed slug; assuming ollama provider`;
      return { slug: candidate, reason };
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
      defaultModel: process.env.LLM_CLOUD_MODEL ?? FALLBACK_DEFAULT_MODEL,
      llmKey: process.env.LLM_CLOUD_API_KEY,
    };
  }

  loadConfig(): Config {
    // Boot forensics breadcrumb: record config.json's on-disk state at
    // every start so the log stream can later correlate "config went
    // missing" with whatever happened just before (update, restart,
    // crash). Existence + mtime + size ONLY — never the contents, which
    // may hold an LLM API key.
    const forensics = statForensics(CONFIG_FILE);
    if (forensics.exists) {
      logger.info(
        `[config] config.json exists (mtime=${forensics.mtime}, size=${forensics.size} bytes)`,
      );
    } else {
      logger.warn('[config] config.json is MISSING at boot (no file present)');
    }

    const resolved = this.resolveOnLoad(forensics);

    const migrated = this.applyMigrations(resolved.config);
    // Persist the rewritten slug + drop deprecated fields so the operator
    // only sees the WARN once instead of every boot — UNLESS we just fell
    // back to defaults after detecting a corrupt config.json with no
    // recoverable .bak. In that case the corrupt bytes are still the live
    // config.json (already copied aside as `.corrupt-<ts>` for forensics),
    // and overwriting them with a defaults-only config on this very boot
    // would destroy the operator's last on-disk state. Fail closed: leave
    // the corrupt file in place this boot; a real save (wizard / CLI) will
    // replace it later.
    if (migrated.changed && !resolved.skipPersist) {
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
   * Resolve the config to load, self-healing from `config.json.bak` when
   * the live file is missing or corrupt. Pre-migration; returns a parsed
   * Config (or {@link defaultConfig} as the last resort) plus a
   * `skipPersist` flag telling {@link loadConfig} whether it is safe to
   * write the post-migration config back to disk on this boot.
   *
   * Permutations:
   *
   *  1. live present + parses        → use it (happy path). persist OK.
   *  2. live MISSING + valid .bak    → restore config.json from .bak, WARN.
   *  3. live CORRUPT + valid .bak    → preserve corrupt as `.corrupt-<ts>`,
   *                                    restore config.json from .bak, WARN.
   *  4. live CORRUPT + no/bad .bak   → preserve corrupt as `.corrupt-<ts>`,
   *                                    fall to defaults, WARN, and set
   *                                    `skipPersist` so the defaults are NOT
   *                                    written over the still-live corrupt
   *                                    config.json on this boot (the corrupt
   *                                    bytes are the operator's last state).
   *  5. live MISSING + no .bak       → defaults, WARN (nothing to recover).
   *                                    persist OK — there is no file to clobber.
   *
   * @param forensics the boot snapshot already taken by {@link loadConfig};
   *   passed in (rather than re-stat'd) so the existence decision matches
   *   the breadcrumb that was just logged.
   */
  private resolveOnLoad(
    forensics: ConfigFileForensics,
  ): { config: Config; skipPersist: boolean } {
    if (forensics.exists) {
      const live = this.tryParseFile(CONFIG_FILE);
      if (live) return { config: live, skipPersist: false };

      // Live file is corrupt. Preserve the bytes for forensics BEFORE
      // any restore touches config.json, so the evidence is never lost.
      const preserved = this.preserveCorruptFile();
      const fromBak = this.tryParseFile(CONFIG_BAK_FILE);
      if (fromBak) {
        this.restoreFromBak();
        logger.warn(
          `[config] config.json was CORRUPT — preserved as ${preserved ?? '(copy failed)'} ` +
            'and restored from config.json.bak',
        );
        return { config: fromBak, skipPersist: false };
      }
      logger.warn(
        `[config] config.json was CORRUPT with no valid config.json.bak — ` +
          `preserved corrupt file as ${preserved ?? '(copy failed)'}, falling back to defaults ` +
          `(corrupt file left in place this boot)`,
      );
      return { config: this.defaultConfig(), skipPersist: true };
    }

    // Live file is absent.
    const fromBak = this.tryParseFile(CONFIG_BAK_FILE);
    if (fromBak) {
      this.restoreFromBak();
      logger.warn(
        `[config] config.json was MISSING at boot — restored from config.json.bak ` +
          `(mtime=${statForensics(CONFIG_BAK_FILE).mtime})`,
      );
      return { config: fromBak, skipPersist: false };
    }
    logger.warn(
      '[config] config.json was absent at boot and no config.json.bak exists — using defaults',
    );
    return { config: this.defaultConfig(), skipPersist: false };
  }

  /**
   * Read + JSON.parse a file, returning the Config on success or `null`
   * when the file is missing, unreadable, or not valid JSON. Never throws
   * and never logs the contents — the caller decides what to do with the
   * `null`.
   */
  private tryParseFile(path: string): Config | null {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8')) as Config;
    } catch {
      return null;
    }
  }

  /**
   * Copy a corrupt config.json aside as `config.json.corrupt-<timestamp>`
   * so an operator (or a future debugging session) can inspect exactly
   * what was on disk when the parse failed. Returns the basename of the
   * preserved copy, or `null` if the copy could not be made. Best-effort:
   * a failure here must never block the self-heal.
   */
  private preserveCorruptFile(): string | null {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(CONFIG_DIR, `config.json.corrupt-${stamp}`);
    try {
      copyFileSync(CONFIG_FILE, dest);
      return `config.json.corrupt-${stamp}`;
    } catch {
      return null;
    }
  }

  /**
   * Restore config.json from config.json.bak. Best-effort: a copy failure
   * is logged but does not throw — the parsed `.bak` Config has already
   * been handed back to the caller, so the running process is correct even
   * if the on-disk restore did not land.
   */
  private restoreFromBak(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      copyFileSync(CONFIG_BAK_FILE, CONFIG_FILE);
    } catch (err) {
      logger.warn(
        `[config] failed to restore config.json from .bak on disk: ${(err as Error).message}`,
      );
    }
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
    const serialized = JSON.stringify(config, null, 2);

    // Atomic write of the live file: write a temp sibling then rename
    // over config.json. A crash mid-write can leave the .tmp behind but
    // can never leave config.json half-written / corrupt.
    this.atomicWrite(CONFIG_FILE, serialized);

    // Mirror to config.json.bak ONLY for configs that carry real operator
    // state. A defaults-only config (the qwen0.5b fallback the node writes
    // after a reset) must never clobber a good .bak — otherwise the
    // self-heal on the next boot would "restore" defaults and the
    // operator's real config would be lost for good.
    if (isWorthBackingUp(config)) {
      try {
        this.atomicWrite(CONFIG_BAK_FILE, serialized);
      } catch (err) {
        // A failed backup must not fail the save — the live file is
        // already persisted; the .bak is a best-effort safety net.
        logger.warn(`[config] failed to write config.json.bak: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Write `data` to `path` atomically: serialize to `<path>.tmp`, then
   * `renameSync` over the target (rename is atomic on the same
   * filesystem). On failure the partial `.tmp` is removed so a retry is
   * clean and the target is never left half-written.
   */
  private atomicWrite(path: string, data: string): void {
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, data);
      renameSync(tmp, path);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* best-effort cleanup of the temp file */
      }
      throw err;
    }
  }

  validateCoordinatorUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
  }

  validateModelFormat(model: string): boolean {
    return MODEL_SLUG_REGEX.test(model);
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
