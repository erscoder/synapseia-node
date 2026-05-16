#!/usr/bin/env node
// Load .env before anything else — must be first import
// Search order: cwd, ~/.synapseia, package directory
// Configure @noble/ed25519 sha512Sync BEFORE any other imports that use it
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { config as dotenvConfig } from 'dotenv';
import { existsSync as dotenvExists } from 'fs';
import { join as dotenvJoin } from 'path';
import { homedir as dotenvHomedir } from 'os';
import { setMaxListeners } from 'events';

// `__dirname` is provided in both runtimes: tsup `shims: true` injects
// it into the production ESM bundle, and Node injects it natively in
// CJS. See `tsup.config.ts` and `self-updater.ts` for the rationale.

// Suppress AbortSignal/EventTarget MaxListeners warning — LangGraph + libp2p create many
// abort signals internally and Node.js 22 emits warnings when >10 listeners accumulate.
setMaxListeners(Infinity);

// NOTE: the `bigint: Failed to load bindings` stderr filter lives in
// `bootstrap.ts` (the real CLI entry). Putting it here would be too late —
// ESM imports are hoisted and fire before this file's top-level runs.

(function loadDotEnv() {
  const candidates = [
    dotenvJoin(process.cwd(), '.env'),
    dotenvJoin(dotenvHomedir(), '.synapseia', '.env'),
    dotenvJoin(__dirname, '..', '.env'),
    dotenvJoin(__dirname, '..', '..', '.env'),
  ];
  for (const f of candidates) {
    // `quiet: true` silences dotenv's startup banner ("[dotenv@17.x]
    // injecting env … tip: encrypt with Dotenvx"). We don't need the tip.
    if (dotenvExists(f)) { dotenvConfig({ path: f, debug: false, quiet: true }); break; }
  }
})();
import { initTracing } from '../instrumentation';

// Activate Langfuse OTel tracing before any NestJS module loads.
// Dynamic import inside initTracing() — no-op (zero packages loaded) when LANGFUSE_SECRET_KEY is unset.
await initTracing();

import logger from '../utils/logger';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as path from 'path';
import * as os from 'os';
import { AppModule } from '../app.module';
import { IdentityService } from '../modules/identity/services/identity.service';
import { HardwareService } from '../modules/hardware/services/hardware.service';
import { NodeConfigService } from '../modules/config/services/node-config.service';
import { WalletService } from '../modules/wallet/services/wallet.service';
import { EncryptedKeystore, EncryptedKeystoreError } from '../infrastructure/keystore/EncryptedKeystore';
import { ModelCatalogHelper, getOllamaTag } from '../modules/model/model-catalog';
import { LlmProviderHelper } from '../modules/llm/llm-provider';
import { CLOUD_PROVIDERS, resolveCloudApiKeyFromEnv } from '../modules/llm/providers';
import { LangGraphWorkOrderAgentService } from '../modules/agent/services/langgraph-work-order-agent.service';
import { WorkOrderPushQueue } from '../modules/agent/work-order/work-order-push-queue';
import { ReviewAgentHelper } from '../modules/agent/review-agent';
import { P2pService } from '../modules/p2p/services/p2p.service';
import { startNode } from '../node-runtime';
import { input, select, confirm, password } from '@inquirer/prompts';
import { getSynBalance, getStakedAmount } from '../modules/wallet/solana-balance';
import { stakeTokens, unstakeTokens, claimStakingRewards, getStakeInfo, depositSol, depositSyn, withdrawSol, withdrawSyn, getWalletBalance } from '../modules/staking/staking-cli';
import { activateNode } from '../modules/wallet/activation';
import type { ModelInfo, HardwareTier } from '../modules/hardware/hardware';
import { CONFIG_FILE, MODEL_SLUG_REGEX, DEFAULT_SOLANA_RPC_URL } from '../modules/config/config';
import { getCoordinatorUrl, getCoordinatorWsUrl } from '../constants/coordinator';
import { HeartbeatHelper, warmCapabilityProbes } from '../modules/heartbeat/heartbeat';
import { acquireLock, releaseLock, getActiveLock, type NodeLockSource } from '../modules/node-lock/node-lock';
import {
  getGlobalTelemetryClient,
  TelemetryClient,
} from '../modules/telemetry/telemetry';
import {
  makeUncaughtExceptionEvent,
  makeUnhandledRejectionEvent,
  type HwFingerprint,
} from '../modules/telemetry/event-builder';

// ── Global SIGINT handler ────────────────────────────────────────────────────
function isExitError(e: unknown): boolean {
  const err = e as { constructor?: { name?: string }; message?: string };
  return err?.constructor?.name === 'ExitPromptError' || !!err?.message?.includes('force closed');
}
process.on('uncaughtException', (err: unknown) => {
  if (isExitError(err)) {
    logger.log('\nBye 👋');
    process.exit(0);
  }
  const e = err as Error;
  // Best-effort telemetry — emit BEFORE logger.error so the
  // exception.uncaught event captures the raw error, not the
  // already-tapped subsystem.error from logger.error itself.
  // drainAll() is awaited via .then() so we still exit on schedule
  // even if the network is down (drainAll has its own deadline).
  emitTelemetryException('uncaught', err);
  logger.error(`[uncaughtException] ${e?.name ?? 'Unknown'}: ${e?.message ?? JSON.stringify(err)}`);
  if (e?.stack) logger.error(e.stack);
  void drainTelemetryThenExit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  if (isExitError(reason)) {
    logger.log('\nBye 👋');
    process.exit(0);
  }
  const e = reason as Error & { code?: string };

  // Known-benign libp2p races: a peer disconnects between gossipsub
  // queueing a control frame (subscriptions, heartbeats) and Yamux
  // flushing it. Surfaces as `StreamStateError` from gossipsub's
  // internal sendRpc/sendSubscriptions path, with a stack rooted in
  // node_modules/@libp2p/gossipsub. The protocol recovers on the next
  // gossipsub tick. Logging these as `error` produced ~12 telemetry
  // events for each transient peer churn — drop to debug, no telemetry.
  if (e?.name === 'StreamStateError' || e?.code === 'ERR_STREAM_RESET') {
    logger.debug(`[p2p] benign stream race ignored: ${e?.name ?? 'StreamError'}: ${e?.message ?? ''}`);
    return;
  }

  emitTelemetryException('rejection', reason);
  logger.error(`[unhandledRejection] ${e?.name ?? 'Unknown'}: ${e?.message ?? JSON.stringify(reason)}`);
  if (e?.stack) logger.error(e.stack);
  // Don't exit on unhandled rejections — just log them (node continues running)
});

/**
 * Best-effort telemetry emission from process-level handlers.
 * The TelemetryClient may not be configured yet (early-boot crashes)
 * — silently no-op in that case.
 */
function emitTelemetryException(
  kind: 'uncaught' | 'rejection',
  reason: unknown,
): void {
  try {
    const client = getGlobalTelemetryClient();
    if (!client) return;
    const fallbackHw: HwFingerprint = {
      os: process.platform,
      arch: process.arch,
    };
    const ev =
      kind === 'uncaught'
        ? makeUncaughtExceptionEvent(fallbackHw, reason)
        : makeUnhandledRejectionEvent(fallbackHw, reason);
    client.emit(ev);
  } catch {
    // Telemetry must NEVER block the crash path.
  }
}

function drainTelemetryThenExit(code: number): Promise<void> {
  return Promise.resolve()
    .then(async () => {
      try {
        const client = getGlobalTelemetryClient();
        if (client) await client.drainAll(2_000);
      } catch {
        // ignore
      }
    })
    .then(() => {
      process.exit(code);
    })
    .catch(() => process.exit(code));
}

async function safePrompt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isExitError(err)) return null;
    throw err;
  }
}

// Passphrase resolution helper extracted to a shared module so subcommand
// CLIs (modules/staking/staking-cli.ts) can reuse the same F9-hardened
// file-mounted-secret rules without duplicating logic.
import { readPassphraseFromFile } from '../infrastructure/keystore/passphrase-helpers';

// ASCII-only banner. The previous box-drawing + heavy-block art rendered
// fine in a terminal but turned into mojibake squares in the node-ui log
// viewer (Tauri webview's monospace font fallback chain lacks the
// block-element + box-drawing glyphs). Plain ASCII renders identically
// everywhere, which is the contract the operator-facing log surface
// needs to honour.
const SYPNASEIA_HEADER = `
================================================================
                          SYNAPSEIA NODE
                Decentralized AI Compute Network
================================================================
`;

function getPackageVersion(): string {
  // Walk up from this file's directory looking for the FIRST package.json
  // whose `name` looks like the synapseia node package. Robust across
  // dev (src/cli/), production bundle (dist/), and any future relocation.
  try {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name && pkg.name.includes('synapseia') && pkg.version) {
          return pkg.version;
        }
      }
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    return '0.2.0';
  } catch {
    return '0.2.0';
  }
}

function getTierName(tier: number): string {
  const tierNames: Record<number, string> = {
    0: 'CPU',
    1: '8GB GPU',
    2: '16GB GPU',
    3: '24GB GPU',
    4: '32GB GPU',
    5: '80GB GPU',
  };
  return tierNames[tier] || 'Unknown';
}

interface StatusOutput {
  peerId: string | null;
  hardwareClass: number;
  wallet: string;
  balance: number;
  staked: number;
  hasOllama: boolean;
  cpuCores: number;
  ramGb: number;
  gpuVramGb: number;
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  const identityService = app.get(IdentityService);
  const hardwareService = app.get(HardwareService);
  const configService = app.get(NodeConfigService);
  const walletService = app.get(WalletService);
  const modelCatalogService = app.get(ModelCatalogHelper);
  const llmService = app.get(LlmProviderHelper);
  const workOrderAgentService = app.get(LangGraphWorkOrderAgentService);
  const workOrderPushQueue = app.get(WorkOrderPushQueue);
  const reviewAgentHelper = app.get(ReviewAgentHelper);
  const p2pService = app.get(P2pService);
  const heartbeatHelper =app.get(HeartbeatHelper)

  // H-3: warm capability probe caches in parallel so the first heartbeat
  // tick (+0s) doesn't pay the cold-start cost of 3 sequential python3
  // spawns + Vina probe (8-15s worst-case, risks >60s tick deadline).
  warmCapabilityProbes();

  const VERSION = getPackageVersion();
  const program = new Command();
  program.name('synapseia').description('Synapseia Network Node CLI').version(VERSION);

  // ── start ──────────────────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start Synapseia node')
    .option('--model <name>', 'Model to use (default: recommended for hardware)')
    .option('--llm-key <key>', 'API key for cloud LLM provider')
    .option(
      '--llm-url <url>',
      '[DEPRECATED, ignored] LLM endpoints are hardcoded per provider; flag kept so existing docker-compose / systemd configs that still pass it boot cleanly instead of crashing on commander.js validation.',
    )
    .option('--max-iterations <n>', 'Maximum work order iterations (default: infinite)', parseInt)
    .option('--inference', 'Enable inference mode (expose GPU as AI inference provider)')
    .option('--inference-models <models>', 'Comma-separated list of models to serve (e.g. ollama/qwen2.5:7b,ollama/llama3:8b)')
    .option('--lat <lat>', 'Latitude for geo-location (optional)')
    .option('--lng <lng>', 'Longitude for geo-location (optional)')
    .option('--set-name', 'New node name (optional)')
    .option(
      '--lora-validator',
      'Opt in to serving LORA_VALIDATION work orders (Plan 1 Phase 2). Disabled by default — operators must explicitly enable peer-validation participation. Sets LORA_VALIDATOR_ENABLED=true for the lifetime of the process.',
    )
    .action(
      async (options: {
        model?: string;
        llmKey?: string;
        llmUrl?: string;
        maxIterations?: number;
        inference?: boolean;
        inferenceModels?: string;
        lat?: string;
        lng?: string;
        loraValidator?: boolean;
      }) => {
        // LoRA validator opt-in. Flipping this BEFORE the runtime
        // initialises means downstream dispatch code (work-order.execution)
        // sees the enabled flag from the first WO onwards.
        if (options.loraValidator) {
          process.env.LORA_VALIDATOR_ENABLED = 'true';
          logger.log(
            ' --lora-validator: this node will accept LORA_VALIDATION work orders ' +
            '(downloads adapters + validation sets, runs eval subprocess, signs results).',
          );
        }
        if (options.llmUrl) {
          logger.warn(
            `⚠️  --llm-url is deprecated and ignored (endpoints are hardcoded per provider). Drop it from your start command.`,
          );
        }
        // Fail fast if another Synapseia node is already running somewhere
        // on this machine (either from the CLI or from the desktop UI).
        // Doing this BEFORE the password prompt / RPC work saves the user
        // from typing a password only to be told they can't start.
        const existingLock = getActiveLock();
        if (existingLock) {
          const who = existingLock.source === 'ui' ? 'from the desktop UI' : 'from the CLI';
          logger.error(
            `❌ Another Synapseia node is already running ${who} (PID ${existingLock.pid}).`
          );
          logger.error(`   Started at: ${existingLock.startedAt}`);
          logger.error(`   Stop it before running 'synapseia start' again.`);
          process.exit(6);
        }

        const config = configService.load();
        // Resolve nodeHome to a CONCRETE path up-front. Passing
        // `process.env.SYNAPSEIA_HOME` raw (undefined when not set) and
        // relying on the default-param in getOrCreateIdentity made every
        // call-site recompute the default independently, splitting a subtle
        // risk across files. Resolve once here, pass the resolved path
        // everywhere downstream.
        const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');

        // Check if identity exists; if not, prompt for a name (or read from NODE_NAME env for non-interactive/docker)
        let nodeName: string | undefined;
        if (!existsSync(path.join(nodeHome, 'identity.json'))) {
          if (process.env.NODE_NAME) {
            nodeName = process.env.NODE_NAME.trim();
            logger.log(`Using node name from NODE_NAME env: ${nodeName}`);
          } else {
            const { input } = await import('@inquirer/prompts');
            nodeName = await input({
              message: 'Choose a name for this node (e.g. "node-alpha"):',
              validate: (v: string) => v.trim().length > 0 || 'Name cannot be empty',
            });
            nodeName = nodeName.trim();
          }
        }

        const identity = identityService.getOrCreate(nodeHome, nodeName);
        const hardware = hardwareService.detect();

        // Phase 0.3 premortem F9 remediation: gate the legacy
        // walletService.getOrCreate() (which decrypts wallet.json using
        // SYNAPSEIA_WALLET_PASSWORD from .env) behind keystore-absence.
        // When a hardened keystore exists, the legacy plaintext path
        // must NEVER run at boot. We resolve the keystore branch below
        // and only fall back to walletService.getOrCreate when no
        // keystore file is present.
        const keystore = new EncryptedKeystore();
        // `wallet` mirrors the legacy `SolanaWallet` shape so downstream
        // banner / activation code does not branch. createdAt is filled
        // with the current ISO timestamp on the keystore path (we do not
        // persist it back to disk; it is only used as a human label).
        let wallet: { publicKey: string; secretKey: number[]; createdAt: string; mnemonic?: string };
        let isNew = false;
        let secretKeyBytes: Uint8Array;
        let keystoreActive = keystore.exists();

        // Fresh-install detection: neither the hardened keystore NOR the
        // legacy wallet.json exist on disk. Generate a fresh keypair
        // straight into the keystore with a SINGLE passphrase prompt,
        // skipping the legacy walletService.getOrCreate() path entirely.
        // This avoids creating a legacy wallet.json on first boot just
        // to migrate it seconds later (which used to ask the operator
        // for TWO passwords back-to-back on first boot).
        const legacyWalletPath = path.join(nodeHome, 'wallet.json');
        const legacyWalletExists = existsSync(legacyWalletPath);

        if (!keystoreActive && !legacyWalletExists) {
          // Symmetric with the hardened-branch contract: a passphrase
          // mounted via SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE unlocks the
          // non-TTY container path. Without this fallback, supervisor /
          // systemd / Docker fresh boots could not bootstrap a wallet.
          const { password: passwordPrompt } = await import('@inquirer/prompts');
          const solanaWeb3 = await import('@solana/web3.js');
          const bip39 = await import('bip39');
          const filePass = await readPassphraseFromFile(
            process.env.SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE,
            logger,
          );
          if (!filePass && !process.stdin.isTTY) {
            logger.error('[Keystore] no wallet found and stdin is not a TTY — cannot prompt for a new passphrase. Set SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE or run on an interactive shell first.');
            process.exit(7);
          }
          if (filePass != null && filePass.length < 12) {
            logger.error('[Keystore] SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE passphrase is shorter than 12 characters — aborting');
            process.exit(7);
          }
          logger.log('First-time setup: creating a new wallet and encrypting it into the hardened keystore.');
          let pass1: string;
          if (filePass != null) {
            pass1 = filePass;
            logger.log('[Keystore] passphrase loaded from SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE — skipping interactive prompt');
          } else {
            pass1 = await passwordPrompt({
              message: 'New keystore passphrase (min 12 chars):',
              validate: (v: string) => v.length >= 12 || 'Passphrase must be at least 12 characters',
            });
            const pass2 = await passwordPrompt({ message: 'Confirm passphrase:' });
            if (pass1 !== pass2) {
              logger.error('[Keystore] passphrases do not match — aborting');
              process.exit(7);
            }
          }
          // Generate via BIP39 so the operator gets a recovery phrase to
          // back up (same convention as the legacy walletService path).
          const mnemonic = bip39.generateMnemonic(128);
          const seed = await bip39.mnemonicToSeed(mnemonic);
          const seedBytes = new Uint8Array(seed).slice(0, 32);
          const fresh = solanaWeb3.Keypair.fromSeed(seedBytes);
          secretKeyBytes = fresh.secretKey;
          await keystore.encrypt(secretKeyBytes, pass1);
          logger.log(`[Keystore] new wallet encrypted at ${keystore.getPath()} (mode 0600)`);
          // Inline backup banner — `walletService.displayCreationWarning`
          // references the legacy wallet.json.backup file which the
          // keystore path never writes (P10 / reviewer MEDIUM-7). Be
          // explicit about WHERE the wallet lives and that the mnemonic
          // is the operator's ONLY off-disk recovery path.
          logger.warn('');
          logger.warn('🔐  IMPORTANT — write down this recovery phrase NOW:');
          logger.warn(`     ${mnemonic}`);
          logger.warn('');
          logger.warn(`     Wallet address: ${fresh.publicKey.toBase58()}`);
          logger.warn(`     Keystore file:  ${keystore.getPath()}`);
          logger.warn('     The mnemonic is the ONLY way to recover this wallet if the keystore file is lost or corrupted. Store it offline (paper or hardware) and never share it.');
          logger.warn('');
          wallet = {
            publicKey: fresh.publicKey.toBase58(),
            secretKey: Array.from(secretKeyBytes),
            createdAt: new Date().toISOString(),
            mnemonic,
          };
          // Suppress the legacy `walletService.displayCreationWarning`
          // below — the inline banner above already covered backup.
          // Leaving `isNew = false` skips that block while keeping the
          // downstream wiring (activation, banner) untouched.
          isNew = false;
          // Mark keystore as active so the legacy migration prompt
          // (further down) does not fire on the same boot.
          keystoreActive = true;
        } else if (keystoreActive) {
          // Hardened branch — passphrase resolution chain:
          //   1. SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE  (file-mounted secret)
          //   2. SYNAPSEIA_WALLET_PASSWORD / WALLET_PASSWORD  (env var,
          //      mirrors what node-ui Tauri's start_node passes when
          //      spawning the CLI — operators don't get a TTY in that
          //      flow and would otherwise hang on the prompt below)
          //   3. interactive prompt (3-attempt retry)
          const { password: passwordPrompt } = await import('@inquirer/prompts');
          const filePass = await readPassphraseFromFile(
            process.env.SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE,
            logger,
          );
          const envPassRaw = process.env.SYNAPSEIA_WALLET_PASSWORD?.trim()
            || process.env.WALLET_PASSWORD?.trim();
          let envPass = filePass ?? (envPassRaw && envPassRaw.length > 0 ? envPassRaw : null);
          let attempts = 0;
          const maxAttempts = 3;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const pass = envPass ?? await passwordPrompt({
              message: `Unlock wallet keystore (${keystore.getPath()}):`,
            });
            envPass = undefined;
            try {
              secretKeyBytes = await keystore.decrypt(pass);
              break;
            } catch (err) {
              if (err instanceof EncryptedKeystoreError && err.code === 'INVALID_PASSPHRASE') {
                attempts++;
                if (attempts >= maxAttempts) {
                  logger.error('[Keystore] invalid passphrase after 3 attempts');
                  process.exit(7);
                }
                logger.warn('[Keystore] invalid passphrase, try again');
                continue;
              }
              logger.error(`[Keystore] failed to unlock: ${(err as Error).message}`);
              process.exit(7);
            }
          }
          // Reconstruct wallet for downstream banner / activation usage.
          // We avoid touching walletService entirely to make sure no
          // legacy SYNAPSEIA_WALLET_PASSWORD env read can happen.
          const { Keypair: KeypairCtor } = await import('@solana/web3.js');
          const kp = KeypairCtor.fromSecretKey(secretKeyBytes);
          wallet = {
            publicKey: kp.publicKey.toBase58(),
            secretKey: Array.from(secretKeyBytes),
            createdAt: new Date().toISOString(),
          };
        } else {
          // Legacy fallback: existing behaviour. Will be removed once
          // all operators have migrated to the keystore.
          const legacy = await walletService.getOrCreate(nodeHome);
          wallet = legacy.wallet;
          isNew = legacy.isNew;
          secretKeyBytes = new Uint8Array(wallet.secretKey);
        }

        if (isNew) {
          walletService.displayCreationWarning(wallet);
        }
        // Coordinator URL is no longer user-configurable. Resolution chain:
        //   1. process.env.COORDINATOR_URL / COORDINATOR_WS_URL
        //   2. Hardcoded official constant (OFFICIAL_COORDINATOR_URL).
        // Any legacy `config.coordinatorUrl` value on disk is ignored.
        const coordinatorUrl = getCoordinatorUrl();
        const coordinatorWsUrl = getCoordinatorWsUrl();
        // Priority: --model flag > LLM_MODEL env > config.defaultModel
        const model = options.model || process.env.LLM_MODEL || config.defaultModel;
        const inferenceEnabled = options.inference ?? config.inferenceEnabled ?? false;
        const inferenceModels = options.inferenceModels
          ? options.inferenceModels.split(',')
          : (config.inferenceModels ?? []);
        const llmKey = options.llmKey || config.llmKey || resolveCloudApiKeyFromEnv(model);

        let selectedModel: ModelInfo | null = null;
        if (model) {
          const isCloud = configService.isCloudModel(model);

          if (!isCloud) {
            selectedModel = modelCatalogService.getModelByName(model);
            if (!selectedModel) {
              logger.error(`Error: Model '${model}' not found in catalog.`);
              logger.error('Available models:');
              modelCatalogService.getModelCatalog().forEach((m) => {
                logger.error(`  ${m.name} (${m.category}, ${m.minVram}GB VRAM)`);
              });
              process.exit(1);
            }

            const isOllamaModel = model?.startsWith('ollama/') || (!model && hardware.hasOllama);
            if (isOllamaModel && hardware.hardwareClass < (selectedModel?.recommendedTier ?? 0)) {
              logger.error(
                `Error: Model '${model}' requires hardware class ${selectedModel?.recommendedTier} or higher.`
              );
              logger.error(`Your hardware class is ${hardware.hardwareClass}.`);
              process.exit(1);
            }
          }

          if (isCloud && !llmKey) {
            logger.error(`Error: Cloud model '${model}' requires --llm-key`);
            process.exit(1);
          }
        } else {
          const compatibleModels = hardwareService.getCompatibleModels(hardware.gpuVramGb || 0);
          if (compatibleModels.length === 0) {
            // Low-tier hardware (Tier 0 / Docker containers) — LLM not required for training/research WOs
            logger.warn('No compatible LLM models for this hardware tier — node will run training and research WOs without local LLM.');
            selectedModel = null;
          } else {
            selectedModel = compatibleModels[0];
            logger.log(
              `Using recommended model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM)`
            );
          }
        }

        // ── Python deps (venv + torch + LoRA + bitsandbytes) ──────────────
        // Idempotent: each phase probes "already installed" first and skips
        // re-running. The desktop UI invokes `syn install-deps` during its
        // loading screen so by the time the user clicks Start this is a
        // cheap no-op. Terminal users hit the same path on first boot.
        const { installPythonDeps } = await import('../utils/install-deps.js');

        // Operator-facing banner so the terminal doesn't appear hung during
        // the ~700 MB initial install (torch + LoRA stack + apt-get docking).
        // Subsequent boots short-circuit on all-installed and emit only
        // `skip` events, so the banner is cheap to keep unconditional.
        logger.log('');
        logger.log('============================================================');
        logger.log('  Installing node dependencies (first boot only — ~2-5 min)');
        logger.log('  - Python venv at ~/.synapseia/venv');
        logger.log('  - PyTorch (~200 MB)');
        logger.log('  - LoRA training stack: transformers, peft, datasets,');
        logger.log('    safetensors, accelerate (~500 MB)');
        logger.log('  - AutoDock Vina + Open Babel (docking, ~30 MB)');
        logger.log('  Subsequent starts skip everything already installed.');
        logger.log('============================================================');
        logger.log('');

        const installResult = await installPythonDeps({
          hardware,
          onProgress: (e) => {
            const icon = e.status === 'done' ? '✓'
              : e.status === 'error' ? '✗'
              : e.status === 'skip' ? '↷'
              : '⟳';
            logger.log(`  [${icon}] ${e.phase}: ${e.message}`);
          },
        });
        if (!installResult.success && installResult.errors.length > 0) {
          installResult.errors.forEach((e) => logger.warn(`[Install] ${e}`));
        }

        logger.log(SYPNASEIA_HEADER);
        logger.log('Starting Sypnaseia node...');
        logger.log(`Version: ${VERSION}`);
        const displayName = config.name || identity.name || 'unnamed';
        if (displayName !== 'unnamed') logger.log(`Name:   ${displayName}`);
        logger.log(`PeerID: ${identity.peerId}`);
        logger.log(`Wallet: ${wallet.publicKey} (Solana devnet)`);
        logger.log(`Hardware: `);
        logger.log(`  CPU cores: ${hardware.cpuCores}`);
        logger.log(`  RAM: ${hardware.ramGb}`);
        logger.log(`  Hardware class: ${hardware.hardwareClass} (${getTierName(hardware.hardwareClass)})`);
        logger.log(`  Ollama: ${hardware.hasOllama ? 'yes' : 'no'}`);
        if (selectedModel) {
          logger.log(
            `Model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM, ${selectedModel.category || 'unknown'})`
          );
        } else {
          logger.log(`Model: ${model} (cloud)`);
        }
        if (inferenceEnabled) {
          const modelsStr = inferenceModels.length > 0 ? inferenceModels.join(', ') : 'auto-detect from Ollama';
          logger.log(`Inference: ENABLED  models: ${modelsStr}`);
        }

        // Auto-prefix bare model names with 'ollama/' when no provider prefix is present
        const rawModel = model || 'ollama/qwen2.5:0.5b';
        const modelWithPrefix = rawModel.includes('/') ? rawModel : `ollama/${rawModel}`;
        const llmModel = llmService.parseModel(modelWithPrefix);
        if (!llmModel) {
          // Non-fatal for Tier 0 nodes — they can still do training WOs without LLM
          logger.warn(`Warning: Invalid model format '${model}' — node will run without LLM capabilities`);
        }

        // Use HeartbeatHelper as single source of truth for capabilities.
        // CONSERVATIVE PRE-CHECK: this is the static (sync) set; the actual
        // wire payload is recomputed via determineCapabilitiesAsync() each
        // heartbeat and may strip caps when runtimes (PyTorch / Ollama) are
        // unreachable. Banner reports the static set so logs don't lie.
        // Tier is a separate column (`nodes.tier`), NOT a capabilities entry.
        const capabilities = heartbeatHelper.determineCapabilities(hardware);

        // Docking deps (Vina + Open Babel) are installed by the `install-deps` flow
        // invoked at app boot. The desktop UI calls `install_python_deps` Tauri command
        // before the unlock screen so all setup completes before the operator clicks Start.
        // Terminal users get the same idempotent install on first `syn start` via
        // installPythonDeps() called earlier in this action.

        // ── SYN token account activation ─────────────────────────────────────
        logger.log('\nChecking SYN token account activation...');
        const { Keypair } = await import('@solana/web3.js');

        // Phase 0.3 premortem F9 remediation, continued:
        // If we entered the legacy branch above (no keystore on disk),
        // offer a one-shot migration to the hardened keystore. This is
        // strictly opt-in: we never delete the legacy wallet.json.
        if (!keystoreActive
          && process.stdin.isTTY
          && !process.env.SYNAPSEIA_SKIP_KEYSTORE_MIGRATION) {
          try {
            const { confirm, password: passwordPrompt } = await import('@inquirer/prompts');
            logger.warn('[Keystore] legacy wallet detected. Migrating to the hardened keystore reduces exposure to malicious install scripts.');
            const wantMigrate = await confirm({
              message: 'Encrypt your wallet to the new keystore now?',
              default: true,
            });
            if (wantMigrate) {
              const pass1 = await passwordPrompt({
                message: 'New keystore passphrase (min 12 chars):',
                validate: (v: string) => v.length >= 12 || 'Passphrase must be at least 12 characters',
              });
              const pass2 = await passwordPrompt({ message: 'Confirm passphrase:' });
              if (pass1 !== pass2) {
                logger.warn('[Keystore] passphrases do not match, skipping migration');
              } else {
                await keystore.encrypt(secretKeyBytes, pass1);
                logger.log(`[Keystore] wallet encrypted at ${keystore.getPath()} (mode 0600)`);
                logger.warn('[Keystore] you can now remove SYNAPSEIA_WALLET_PASSWORD from your .env and delete legacy wallet.json once you have verified the new keystore unlocks correctly.');
              }
            }
          } catch (err) {
            // Migration is best-effort. Never block boot on a prompt
            // failure (e.g. piped stdin); just log and continue.
            logger.warn(`[Keystore] migration skipped: ${(err as Error).message}`);
          }
        }
        const walletKeypair = Keypair.fromSecretKey(secretKeyBytes);
        const activation = await activateNode(wallet.publicKey, walletKeypair);
        if (!activation.activated) {
          logger.error('❌ Activation failed — cannot start node without SYN token account');
          logger.error(`   Error: ${activation.error}`);
          process.exit(1);
        }
        if (activation.synTokenAccount) {
          logger.log(`✅ SYN token account: ${activation.synTokenAccount}`);
        }

        // Claim the lock immediately before starting the runtime so any
        // concurrent `synapseia start` (or UI launch) that squeezed in
        // after our early check still loses cleanly.
        const launchSource: NodeLockSource =
          process.env.SYNAPSEIA_LAUNCH_SOURCE === 'ui' ? 'ui' : 'cli';
        try {
          acquireLock(launchSource);
        } catch (err) {
          logger.error(`❌ ${(err as Error).message}`);
          process.exit(6);
        }

        // Telemetry client (DI'd, configured + started inside startNode).
        const telemetryClient = app.get(TelemetryClient);

        // ── Hand off to the node runtime ──────────────────────────────────
        const runtime = await startNode(
          {
            identity,
            name: config.name || identity.name || 'unnamed',
            walletAddress: wallet.publicKey,
            hardwareClass: hardware.hardwareClass,
            coordinatorUrl,
            coordinatorWsUrl,
            capabilities,
            llmModel: llmModel ?? { provider: 'ollama', modelId: 'all-minilm-l6-v2', providerId: '' },
            llmConfig: { apiKey: llmKey },
            intervalMs: 60000,
            // Fallback poll for /work-orders/available — overridable via env so
            // load-test rigs can dial it down when needed. Default 5 min;
            // gossipsub WORK_ORDER_AVAILABLE drives discovery in real time.
            workOrderIntervalMs: parseInt(process.env.WO_POLL_INTERVAL_MS ?? '300000', 10),
            maxIterations: options.maxIterations,
            lat: config.lat,
            lng: config.lng,
          },
          { p2pService, workOrderAgentService, telemetryClient, workOrderPushQueue, reviewAgentHelper },
          hardware,
        );

        const cleanupLock = () => {
          try { releaseLock(); } catch { /* best-effort */ }
        };
        process.on('exit', cleanupLock);
        process.on('SIGINT', async () => {
          await runtime.stop();
          cleanupLock();
          process.exit(0);
        });
        process.on('SIGTERM', async () => {
          await runtime.stop();
          cleanupLock();
          process.exit(0);
        });

        // Keep alive — startNode fires the agent loop in the background
        await new Promise<void>(() => {});
      }
    );

  // ── install-deps ───────────────────────────────────────────────────────────
  // Standalone pre-boot setup step. Streams phase events as JSON lines
  // prefixed with `[INSTALL_PROGRESS]` so the Tauri parent can parse them
  // and forward to the desktop loading screen. Idempotent — safe to invoke
  // on every UI boot; phases that are already satisfied emit `status: 'skip'`.
  // Does NOT require wallet unlock or any config — it's purely a dep install.
  program
    .command('install-deps')
    .description('Install Python deps (venv, torch, LoRA stack, bitsandbytes) for training caps')
    .action(async () => {
      const { installPythonDeps } = await import('../utils/install-deps.js');
      const hardware = hardwareService.detect();
      const result = await installPythonDeps({
        hardware,
        onProgress: (event) => {
          // The `[INSTALL_PROGRESS]` prefix is the contract with Tauri parsing.
          // One JSON object per line, single-line so split-on-\n works upstream.
          process.stdout.write(`[INSTALL_PROGRESS] ${JSON.stringify(event)}\n`);
        },
      });
      process.exit(result.success ? 0 : 1);
    });

  // ── status ─────────────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show node status')
    .action(async () => {
      const identity = identityService.getOrCreate();
      const hardware = hardwareService.detect();
      const walletAddress = walletService.getAddress(process.env.SYNAPSEIA_HOME);
      const config = configService.load();

      const [balance, staked] = walletAddress
        ? await Promise.all([
            getSynBalance(walletAddress),
            getStakedAmount(walletAddress, getCoordinatorUrl()),
          ])
        : [0, 0];

      const status: StatusOutput = {
        peerId: identity?.peerId || null,
        hardwareClass: hardware.hardwareClass,
        wallet: walletAddress,
        balance,
        staked,
        hasOllama: hardware.hasOllama,
        cpuCores: hardware.cpuCores,
        ramGb: hardware.ramGb,
        gpuVramGb: hardware.gpuVramGb,
      };

      logger.log(SYPNASEIA_HEADER);
      logger.log('Node Status:');
      if (identity.name) logger.log(`Name:    ${identity.name}`);
      logger.log(`PeerID:  ${status.peerId || 'Not initialized'}`);
      logger.log(`Hardware class: ${status.hardwareClass} (${getTierName(status.hardwareClass)})`);
      logger.log(`Wallet:  ${status.wallet}`);
      logger.log(`Balance: ${status.balance} SYN`);
      logger.log(`Staked:  ${status.staked} SYN`);
      logger.log(
        `Hardware: ${status.cpuCores} cores, ${status.ramGb}GB RAM, ${status.gpuVramGb}GB VRAM`
      );
      logger.log(`Ollama:  ${status.hasOllama ? 'Running' : 'Not detected'}`);
    });

  // ── stake ──────────────────────────────────────────────────────────────────
  program
    .command('stake')
    .description('Stake SYN tokens')
    .argument('<amount>', 'Amount to stake (in SYN tokens)')
    .action(async (amount: string) => {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        logger.error('❌ Invalid amount. Please provide a positive number.');
        process.exit(1);
      }
      try {
        await stakeTokens(parsedAmount);
      } catch (error) {
        logger.error('❌ Stake failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  program
    .command('unstake')
    .description('Unstake SYN tokens')
    .argument('<amount>', 'Amount to unstake (in SYN tokens)')
    .action(async (amount: string) => {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        logger.error('❌ Invalid amount. Please provide a positive number.');
        process.exit(1);
      }
      try {
        await unstakeTokens(parsedAmount);
      } catch (error) {
        logger.error('❌ Unstake failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ── claim rewards ─────────────────────────────────────────────────────────
  program
    .command('claim-rewards')
    .description('Claim pending staking rewards')
    .action(async () => {
      try {
        await claimStakingRewards();
      } catch (error) {
        logger.error('❌ Claim failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ── claim work-order rewards (vault) ──────────────────────────────────────
  // Claims accrued rewards from the `syn_rewards_vault` program's RewardAccount
  // PDA. Separate pool from staking rewards — this is where training/research/
  // DiLoCo/peer-review earnings go.
  program
    .command('claim-wo-rewards')
    .description('Claim pending work-order rewards from the on-chain rewards vault')
    .action(async () => {
      try {
        const { claimWorkOrderRewards } = await import('../modules/rewards/rewards-vault-cli');
        const sig = await claimWorkOrderRewards();
        logger.log(`__VAULT_CLAIM_OK__ ${sig}`);
        logger.log(`✅ Rewards claimed. Tx: ${sig}`);
        process.exit(0);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Vault claim failed: ${msg}`);
        process.exit(1);
      }
    });

  // ── stake info ────────────────────────────────────────────────────────────
  program
    .command('stake-info')
    .description('Show current stake information')
    .action(async () => {
      try {
        const info = await getStakeInfo();
        if (!info) {
          logger.log('ℹ️ No stake account found. Stake some SYN tokens first.');
          return;
        }
        logger.log('\n📊 Stake Information:');
        logger.log(`   Staked: ${info.amount} SYN`);
        logger.log(`   Tier: ${info.tier}`);
        logger.log(`   Pending Rewards: ${info.rewardsPending} SYN`);
        if (info.lockedUntil > 0) {
          const unlockDate = new Date(info.lockedUntil * 1000);
          logger.log(`   Locked Until: ${unlockDate.toLocaleString()}`);
        }
      } catch (error) {
        logger.error('❌ Failed to get stake info:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ── wallet balance ───────────────────────────────────────────────────────
  program
    .command('balance')
    .description('Show wallet balance (SOL and SYN)')
    .action(async () => {
      try {
        const balance = await getWalletBalance();
        logger.log('\n💰 Wallet Balance:');
        logger.log(`   SOL: ${balance.sol.toFixed(4)}`);
        logger.log(`   SYN: ${balance.syn.toFixed(4)}`);
      } catch (error) {
        logger.error('❌ Failed to get balance:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ── deposit ───────────────────────────────────────────────────────────────
  program
    .command('deposit-sol')
    .description('Request SOL airdrop (devnet only)')
    .argument('<amount>', 'Amount of SOL to request')
    .action(async (amount: string) => {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        logger.error('❌ Invalid amount. Please provide a positive number.');
        process.exit(1);
      }
      try {
        await depositSol(parsedAmount);
      } catch (error) {
        logger.error('❌ Deposit failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  program
    .command('deposit-syn')
    .description('Show token account address for depositing SYN')
    .argument('[amount]', 'Amount of SYN (optional, for info)')
    .action(async (amount: string) => {
      try {
        await depositSyn(amount ? parseFloat(amount) : 0);
      } catch (error) {
        logger.error('❌ Deposit failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ── withdraw ─────────────────────────────────────────────────────────────
  program
    .command('withdraw-sol')
    .description('Withdraw SOL to another wallet')
    .argument('<amount>', 'Amount of SOL to withdraw')
    .argument('<destination>', 'Destination wallet address')
    .action(async (amount: string, destination: string) => {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        logger.error('❌ Invalid amount. Please provide a positive number.');
        process.exit(1);
      }
      try {
        await withdrawSol(parsedAmount, destination);
      } catch (error) {
        logger.error('❌ Withdraw failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  program
    .command('withdraw-syn')
    .description('Withdraw SYN to another wallet')
    .argument('<amount>', 'Amount of SYN to withdraw')
    .argument('<destination>', 'Destination wallet address')
    .action(async (amount: string, destination: string) => {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        logger.error('❌ Invalid amount. Please provide a positive number.');
        process.exit(1);
      }
      try {
        await withdrawSyn(parsedAmount, destination);
      } catch (error) {
        logger.error('❌ Withdraw failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ── system-info ────────────────────────────────────────────────────────────
  program
    .command('system-info')
    .description('Show detailed system information')
    .action(async () => {
      const sysInfo = hardwareService.getSystemInfo();
      const recommendedTier = hardwareService.getRecommendedTier(sysInfo.gpu.vramGb);
      const compatibleModels = hardwareService.getCompatibleModels(sysInfo.gpu.vramGb);

      logger.log('═══════════════════════════════════════════════════');
      logger.log('       Synapseia Node - System Information');
      logger.log('═══════════════════════════════════════════════════');
      logger.log();
      logger.log('📋 Operating System:');
      logger.log(`   ${sysInfo.os}`);
      logger.log();
      logger.log('🔧 CPU Information:');
      logger.log(`   Model: ${sysInfo.cpu.model}`);
      logger.log(`   Cores: ${sysInfo.cpu.cores}`);
      logger.log();
      logger.log('💾 Memory:');
      logger.log(`   Total RAM: ${sysInfo.memory.totalGb} GB`);
      logger.log();
      logger.log('🎮 GPU Information:');
      if (sysInfo.gpu.type) {
        logger.log(`   Type: ${sysInfo.gpu.type}`);
        logger.log(`   VRAM: ${sysInfo.gpu.vramGb} GB`);
      } else {
        logger.log('   No GPU detected');
      }
      logger.log();
      logger.log('🎯 Hardware Tier Assessment:');
      const tierName =
        ['CPU-Only', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'][recommendedTier] ||
        'Unknown';
      logger.log(`   Recommended Tier: ${recommendedTier} (${tierName})`);
      logger.log();
      logger.log('🤖 Compatible Models:');
      if (compatibleModels.length > 0) {
        logger.log(
          `   Found ${compatibleModels.length} models compatible with ${sysInfo.gpu.vramGb}GB VRAM:`
        );
        compatibleModels.forEach((model, index) => {
          const tName = ['CPU', 'T1', 'T2', 'T3', 'T4', 'T5'][model.recommendedTier] || 'Unknown';
          logger.log(
            `   ${index + 1}. ${model.name.padEnd(30)} (min ${model.minVram}GB, rec ${tName})`
          );
        });
      } else {
        logger.log('   No compatible models found. Consider upgrading GPU or using cloud LLM.');
      }
      logger.log();
      logger.log('═══════════════════════════════════════════════════');
    });

  // ── export-key ─────────────────────────────────────────────────────────────
  program
    .command('export-key')
    .description('Display the wallet private key (requires password)')
    .action(async () => {
      const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
      const walletPath = path.join(nodeHome, 'wallet.json');

      if (!existsSync(walletPath)) {
        logger.error('No wallet found. Run `syn start` first to create one.');
        process.exit(1);
      }

      logger.log('');
      logger.log('⚠  WARNING: Your private key gives FULL control of your wallet.');
      logger.log('   Never share it with anyone. Never paste it on a website.');
      logger.log('');

      // Honour the env var so the desktop UI (no TTY) can invoke this
      // command non-interactively. Interactive terminal users still get
      // a prompt when no env var is set.
      let pwd: string;
      const envPwd = process.env.SYNAPSEIA_WALLET_PASSWORD ?? process.env.WALLET_PASSWORD;
      if (envPwd) {
        pwd = envPwd;
      } else {
        const { password } = await import('@inquirer/prompts');
        pwd = await password({
          message: 'Enter your wallet password to reveal the private key:',
        });
      }

      try {
        // TODO(phase0.3-followup): migrate `export-keypair` to the
        // hardened EncryptedKeystore so it stops reading the legacy
        // SYNAPSEIA_WALLET_PASSWORD env var and decrypting wallet.json.
        // See CHANGELOG "Known limitations" under the keystore entry.
        const wallet = await walletService.load(nodeHome, pwd);

        const { default: bs58 } = await import('bs58');
        const secretKeyBytes = Uint8Array.from(wallet.secretKey);
        const base58Key = bs58.encode(secretKeyBytes);

        // Sentinel so the UI can extract the key reliably without
        // depending on surrounding log formatting.
        logger.log(`__PRIVATE_KEY__ ${base58Key}`);
        logger.log('');
        logger.log('═══════════════════════════════════════════════════');
        logger.log(`  Wallet address:  ${wallet.publicKey}`);
        logger.log(`  Private key (base58):`);
        logger.log(`  ${base58Key}`);
        logger.log('═══════════════════════════════════════════════════');
        logger.log('');
        logger.log('Copy the private key above. It will NOT be shown again.');
        logger.log('');
        process.exit(0);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('decrypt') || msg.includes('password') || msg.includes('auth')) {
          logger.error('Wrong password. Private key NOT revealed.');
        } else {
          logger.error(`Failed to load wallet: ${msg}`);
        }
        process.exit(1);
      }
    });

  // ── stop ───────────────────────────────────────────────────────────────────
  program
    .command('stop')
    .description('Stop the running Synapseia node')
    .action(() => {
      logger.log('🛑 Stopping Synapseia node...');
      workOrderAgentService.stop();
      logger.log('✅ Node stopped');
    });

  // ── config ─────────────────────────────────────────────────────────────────
  program
    .command('config')
    .description('Interactive configuration wizard')
    .option('--show', 'Show current configuration')
    .option('--set-name <name>', 'Set node name')
    .option('--set-model <model>', 'Set default model (provider/model format)')
    .option('--set-llm-key <key>', 'Set LLM API key')
    .option('--set-llm-url <url>', '[DEPRECATED, ignored] LLM endpoints are now hardcoded per provider')
    .option('--set-rpc-url <url>', 'Set Solana RPC URL (pass "" to clear and use the default devnet RPC)')
    .action(async (options: {
      show?: boolean;
      setName?: string;
      setModel?: string;
      setLlmUrl?: string;
      setLlmKey?: string;
      setRpcUrl?: string;
    }) => {
      const configService = app.get(NodeConfigService);

      const config = configService.load();
      if (options.show) {
        logger.log('Current configuration:');
        logger.log(JSON.stringify(config, null, 2));
        process.exit(0);
      }

      if (options.setName) {
        config.name = options.setName;
        configService.save(config);
        // Also update identity.json so heartbeat sends the new name
        const identityService = app.get(IdentityService);
        const identityDir = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
        identityService.update({ name: options.setName }, identityDir);
        logger.log(`✅ Node name set to: ${options.setName}`);
        process.exit(0);
      }

      if (options.setModel) {
        if (!MODEL_SLUG_REGEX.test(options.setModel)) {
          logger.error(`❌ Invalid model format. Expected provider/model (e.g. openai/gpt-4o). Got: ${options.setModel}`);
          process.exit(1);
        }
        config.defaultModel = options.setModel;
        configService.save(config);
        logger.log(`✅ Default model set to: ${options.setModel}`);
        process.exit(0);
      }

      if (options.setLlmUrl) {
        // Backward-compat: the flag is preserved so older `synapseia-ui`
        // builds and operator scripts that still pass --set-llm-url
        // don't fail outright. The value is no longer persisted because
        // every cloud provider has a hardcoded endpoint now.
        logger.warn(
          `⚠️  --set-llm-url is deprecated and ignored. ` +
            `Endpoints are hardcoded per provider; pick one via 'synapseia config' or the desktop UI.`,
        );
        process.exit(0);
      }

      if (options.setLlmKey) {
        config.llmKey = options.setLlmKey;
        configService.save(config);
        logger.log(`✅ LLM API key set`);
        process.exit(0);
      }

      if (options.setRpcUrl !== undefined) {
        const trimmed = options.setRpcUrl.trim();
        if (trimmed === '') {
          delete config.rpcUrl;
          configService.save(config);
          logger.log(`✅ RPC URL cleared (will use default ${DEFAULT_SOLANA_RPC_URL})`);
          process.exit(0);
        }
        try {
          const parsed = new URL(trimmed);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            logger.error(`❌ RPC URL must use http(s). Got: ${parsed.protocol}`);
            process.exit(1);
          }
        } catch {
          logger.error(`❌ Invalid URL: ${options.setRpcUrl}`);
          process.exit(1);
        }
        config.rpcUrl = trimmed;
        configService.save(config);
        logger.log(`✅ RPC URL set to: ${trimmed}`);
        process.exit(0);
      }

      logger.log('\n🔧 Synapseia Configuration Wizard');
      logger.log('   Use ↑↓ to navigate, Enter to select, Ctrl+C to cancel.\n');

      const catalog = modelCatalogService.getModelCatalog();
      const hardware = hardwareService.detect();
      const compatibleModels = hardwareService.getCompatibleModels(hardware.gpuVramGb || 0);

      const BACK = '__BACK__';

      type Step = 'modelMode' | 'modelPick' | 'llmConfig' | 'inference' | 'rpcUrl' | 'done';
      let step: Step = 'modelMode';
      let modelMode: string | null = null;

      while (step !== 'done') {
        if (step === 'modelMode') {
          const ans = await safePrompt(() =>
            select({
              message: 'How would you like to configure your LLM model?',
              choices: [
                { name: 'Use recommended model for your hardware', value: 'recommended' },
                { name: 'Select from compatible models', value: 'compatible' },
                { name: 'Select from all models', value: 'all' },
                { name: 'Use cloud LLM provider', value: 'cloud' },
              ],
            })
          );
          if (ans === null) { logger.log('\nCancelled.'); return; }
          modelMode = ans;

          if (modelMode === 'recommended') {
            if (compatibleModels.length > 0) {
              config.defaultModel = `ollama/${getOllamaTag(compatibleModels[0])}`;
              logger.log(`  ✓ Recommended model: ${config.defaultModel}`);
              step = 'llmConfig';
            } else {
              logger.log('  ⚠ No compatible local models — switching to cloud picker.');
              modelMode = 'cloud';
              step = 'modelPick';
            }
          } else {
            step = 'modelPick';
          }
          continue;
        }

        if (step === 'modelPick') {
          let choices: {
            name: string;
            value: string;
            description?: string;
            disabled?: string | boolean;
          }[] = [];

          if (modelMode === 'compatible') {
            if (compatibleModels.length === 0) {
              logger.log('  ⚠ No compatible models for your hardware — showing cloud options.');
              modelMode = 'cloud';
            } else {
              choices = compatibleModels.map((m) => ({
                name: `${m.name}  (${m.minVram}GB VRAM, Tier ${m.recommendedTier})`,
                value: `ollama/${getOllamaTag(m)}`,
                description: (m as ModelInfo).description,
              }));
            }
          }

          if (modelMode === 'all') {
            choices = catalog.map((m) => ({
              name: `${m.name}  (${m.category}, ${m.minVram}GB VRAM)`,
              value: `ollama/${getOllamaTag(m)}`,
              description: (m as ModelInfo).description,
              disabled: m.recommendedTier > hardware.hardwareClass ? 'Requires higher hardware class' : false,
            }));
          }

          if (modelMode === 'cloud') {
            // One choice per (provider, tier). Endpoints are hardcoded so
            // there is no "Custom URL" option — pick a vendor and a tier.
            choices = CLOUD_PROVIDERS.flatMap((p) =>
              (['top', 'mid', 'budget'] as const).map((tier) => {
                const desc = p.models[tier];
                const tierLabel = tier === 'top' ? 'Top' : tier === 'mid' ? 'Mid' : 'Budget';
                return {
                  name: `${p.label} — ${tierLabel} (${desc.modelId})`,
                  value: `${p.id}/${desc.modelId}`,
                  description: `Provider: ${p.label}, tier: ${tierLabel}`,
                };
              }),
            );
          }

          // Minimum model for the multi-agent research pipeline (coordinator pattern)
          const MIN_MODEL_FOR_RESEARCH = 'qwen2.5-3b';

          const ans = await safePrompt(() =>
            select({
              message: modelMode === 'cloud' ? 'Select cloud LLM provider:' : 'Select a model:',
              choices: [...choices, { name: '← Back  (change model type)', value: BACK }],
            })
          );
          if (ans === null) { logger.log('\nCancelled.'); return; }
          if (ans === BACK) { step = 'modelMode'; continue; }
          config.defaultModel = ans;

          // Warn if Ollama model is too small for the research coordinator
          if (modelMode !== 'cloud') {
            const selectedModel = catalog.find((m) => m.name === ans);
            const meetsMin = !selectedModel || (selectedModel.minVram ?? 0) >= 4;
            if (!meetsMin) {
              logger.log('');
              logger.warn(`⚠️  '${ans}' is below the recommended minimum (${MIN_MODEL_FOR_RESEARCH}).`);
              logger.warn('   The multi-agent research pipeline works better with qwen2.5-3b or larger.');
              // Check if there are compatible models >= 3b
              const canUpgrade = compatibleModels.some(
                (m) => m.minVram >= 4 && m.name !== ans
              );
              if (canUpgrade) {
                logger.log('   Consider upgrading to a stronger local model, or use cloud LLM.');
              } else {
                logger.warn('   No local model meets the minimum. Switching to cloud LLM.');
                modelMode = 'cloud';
                step = 'modelPick';
                continue;
              }
            }
          }

          step = 'llmConfig';
          continue;
        }

        if (step === 'llmConfig') {
          const usingCloud = configService.isCloudModel(config.defaultModel);
          if (usingCloud) {
            logger.log('\n  ☁️  Cloud LLM configuration (endpoint hardcoded for selected provider).');

            const hasKey = await safePrompt(() =>
              confirm({ message: 'Do you have an API key?', default: true })
            );
            if (hasKey === null) { logger.log('\nCancelled.'); return; }
            if (hasKey) {
              const llmKey = await safePrompt(() =>
                password({ message: 'Enter your API key:', mask: '*' })
              );
              if (llmKey === null) { logger.log('\nCancelled.'); return; }
              if (llmKey) config.llmKey = llmKey;
            } else {
              logger.log('  ⚠ Provide --llm-key when starting the node.');
            }
          }
          // Ollama path: nothing to configure here. Custom Ollama URLs are
          // no longer supported via the wizard — the CLI talks to the local
          // ollama daemon at the standard 127.0.0.1:11434 endpoint.
          step = 'inference';
        }

        if (step === 'inference') {
          const enableInference = await safePrompt(() =>
            confirm({
              message: 'Enable inference mode? (expose GPU as AI inference provider — earns extra SYN)',
              default: config.inferenceEnabled ?? false,
            })
          );
          if (enableInference === null) { logger.log('\nCancelled.'); return; }
          config.inferenceEnabled = enableInference;
          if (enableInference) {
            const modelsInput = await safePrompt(() =>
              input({
                message: 'Models to serve (comma-separated, empty = auto-detect from Ollama):',
                default: (config.inferenceModels ?? []).join(','),
              })
            );
            if (modelsInput === null) { logger.log('\nCancelled.'); return; }
            config.inferenceModels = modelsInput ? modelsInput.split(',').map((s: string) => s.trim()) : [];
            logger.log('  ✓ Inference mode enabled. Start with: synapseia start');
            logger.log('    (or use --inference flag to override per-run)');
          } else {
            config.inferenceModels = [];
          }
          step = 'rpcUrl';
          continue;
        }

        if (step === 'rpcUrl') {
          const current = config.rpcUrl ?? '';
          const ans = await safePrompt(() =>
            input({
              message: `Solana RPC URL (leave blank for default ${DEFAULT_SOLANA_RPC_URL}):`,
              default: current || undefined,
              validate: (v: string) => {
                const t = v.trim();
                if (!t) return true;
                try {
                  const parsed = new URL(t);
                  if (!['http:', 'https:'].includes(parsed.protocol)) {
                    return `URL must use http(s); got ${parsed.protocol}`;
                  }
                  return true;
                } catch {
                  return 'Must be a valid URL (e.g. https://api.devnet.solana.com)';
                }
              },
            })
          );
          if (ans === null) { logger.log('\nCancelled.'); return; }
          const trimmed = ans.trim();
          if (trimmed) {
            config.rpcUrl = trimmed;
            logger.log(`  ✓ RPC URL: ${trimmed}`);
          } else {
            delete config.rpcUrl;
            logger.log(`  ✓ RPC URL: default (${DEFAULT_SOLANA_RPC_URL})`);
          }
          step = 'done';
        }
      }

      configService.save(config);
      logger.log('\n  ✅  Configuration saved to', CONFIG_FILE);
      logger.log('\n  Next steps:');
      logger.log('    synapseia start    # Start the node');
      logger.log('    synapseia status   # Check node status');
    });

  // ── wallet-verify ──────────────────────────────────────────────────────────
  // Non-interactive: validate the operator passphrase against the hardened
  // keystore (~/.synapseia/wallet.keystore.json) when present, otherwise fall
  // back to the legacy wallet.json (so operators who haven't migrated yet
  // still unlock from the desktop UI). Exits 0 on success, 1 on bad
  // passphrase, 2 on missing passphrase, 3 when neither keystore nor legacy
  // wallet are on disk, 4 on any other load error.
  //
  // Passphrase resolution order (matches the boot path semantics):
  //   1. SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE (mounted secret, file-based)
  //   2. SYNAPSEIA_WALLET_PASSWORD / WALLET_PASSWORD (env, back-compat with
  //      the desktop UI `unlock_wallet` Tauri command which still passes the
  //      typed password through SYNAPSEIA_WALLET_PASSWORD).
  //
  // Stdout/stderr markers (`__WALLET_OK__ <pubkey>` and `INVALID_PASSWORD`)
  // are part of the contract with `packages/node-ui/src-tauri/src/commands.rs::unlock_wallet`
  // and MUST NOT change without coordinating a Tauri side update.
  program
    .command('wallet-verify')
    .description('Validate wallet passphrase against keystore (or legacy wallet.json fallback)')
    .action(async () => {
      const filePassphrase = await readPassphraseFromFile(
        process.env.SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE,
        logger,
      );
      const envPassphrase = process.env.SYNAPSEIA_WALLET_PASSWORD ?? process.env.WALLET_PASSWORD;
      const passphrase = filePassphrase ?? envPassphrase;
      if (!passphrase) {
        logger.error('SYNAPSEIA_WALLET_PASSWORD env var or SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE is required for wallet-verify');
        process.exit(2);
      }

      const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
      const keystorePath = path.join(nodeHome, 'wallet.keystore.json');
      const keystore = new EncryptedKeystore(keystorePath);
      const walletPath = path.join(nodeHome, 'wallet.json');
      const keystoreExists = keystore.exists();
      const legacyExists = existsSync(walletPath);

      if (!keystoreExists && !legacyExists) {
        logger.error('WALLET_NOT_FOUND');
        process.exit(3);
      }

      // Keystore branch: when the hardened keystore is on disk it is the
      // ONLY accepted unlock path. The legacy wallet.json fallback would
      // happily validate the old plaintext-encrypted password and the UI
      // would store THAT — but the downstream `syn start` spawn only
      // accepts the vault passphrase to decrypt the keystore, so the
      // operator would unlock the UI and then immediately hang on the
      // start-node prompt. Force vault discipline: keystore present →
      // vault passphrase only.
      if (keystoreExists) {
        try {
          const secretKeyBytes = await keystore.decrypt(passphrase);
          const { Keypair } = await import('@solana/web3.js');
          const kp = Keypair.fromSecretKey(secretKeyBytes);
          logger.log(`__WALLET_OK__ ${kp.publicKey.toBase58()}`);
          process.exit(0);
        } catch (err) {
          if (err instanceof EncryptedKeystoreError && err.code === 'INVALID_PASSPHRASE') {
            logger.error('INVALID_PASSWORD');
            process.exit(1);
          }
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`WALLET_LOAD_ERROR: ${msg}`);
          process.exit(4);
        }
      }

      // Legacy fallback: no keystore present. Operators that have not yet
      // run `syn start` on this machine still unlock from the desktop UI
      // via the legacy plaintext-encrypted wallet.json.
      try {
        const wallet = await walletService.load(nodeHome, passphrase);
        logger.log(`__WALLET_OK__ ${wallet.publicKey}`);
        process.exit(0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/invalid password|decryption failed|auth/i.test(msg)) {
          logger.error('INVALID_PASSWORD');
          process.exit(1);
        }
        logger.error(`WALLET_LOAD_ERROR: ${msg}`);
        process.exit(4);
      }
    });

  // ── wallet-create ──────────────────────────────────────────────────────────
  // Non-interactive: creates a fresh wallet encrypted with
  // SYNAPSEIA_WALLET_PASSWORD and writes node config in one atomic call.
  // Used by the desktop UI during first-time setup. Refuses to overwrite an
  // existing wallet — user must delete it explicitly to re-initialise.
  program
    .command('wallet-create')
    .description('Create a new encrypted wallet + base config (non-interactive)')
    .option('--name <name>', 'Node name')
    .option('--model <model>', 'Default model (provider/model)')
    .option('--llm-key <key>', 'LLM API key')
    .option('--llm-url <url>', '[DEPRECATED, ignored] Endpoints are hardcoded per provider')
    .action(async (options: {
      name?: string;
      model?: string;
      llmUrl?: string;
      llmKey?: string;
    }) => {
      const envPassword = process.env.SYNAPSEIA_WALLET_PASSWORD ?? process.env.WALLET_PASSWORD;
      if (!envPassword) {
        logger.error('SYNAPSEIA_WALLET_PASSWORD env var is required for wallet-create');
        process.exit(2);
      }
      if (envPassword.length < 8) {
        logger.error('PASSWORD_TOO_SHORT: password must be at least 8 characters');
        process.exit(2);
      }
      const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
      const walletPath = path.join(nodeHome, 'wallet.json');
      if (existsSync(walletPath)) {
        logger.error('WALLET_ALREADY_EXISTS');
        process.exit(5);
      }
      try {
        // Create the wallet directory + encrypted wallet.json in one call
        const { wallet } = await walletService.generate(nodeHome, envPassword);

        // Persist the base config atomically (no partial state)
        const cfgService = app.get(NodeConfigService);
        const cfg = cfgService.load();
        if (options.name) cfg.name = options.name;
        if (options.model) cfg.defaultModel = options.model;
        if (options.llmUrl) {
          logger.warn('⚠️  --llm-url is deprecated and ignored (endpoints are hardcoded per provider)');
        }
        if (options.llmKey) cfg.llmKey = options.llmKey;
        cfgService.save(cfg);

        // Keep identity.json in sync with the chosen name so heartbeat broadcasts it
        if (options.name) {
          const identityService = app.get(IdentityService);
          identityService.update({ name: options.name }, nodeHome);
        }

        logger.log(`__WALLET_OK__ ${wallet.publicKey}`);
        process.exit(0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`WALLET_CREATE_ERROR: ${msg}`);
        process.exit(4);
      }
    });

  program.parse();
}

// ── Fast-path: `chain-info` never touches NestJS / P2P / heartbeat ─────────
// The desktop UI polls this every 15s. Booting AppModule here would reconnect
// libp2p and hammer the coordinator on each tick — exactly the noise we're
// trying to eliminate. Short-circuit BEFORE bootstrap() so the helper runs
// in a bare Node.js context with only the imports it needs.
if (process.argv[2] === 'chain-info') {
  import('./chain-info-lightweight').then(({ runChainInfoLightweight }) =>
    runChainInfoLightweight().catch((err) => {
      logger.error(`chain-info failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }),
  );
} else {
  bootstrap().catch((err) => {
    const e = err as Error;
    logger.error(`[FATAL] ${e?.name ?? 'Error'}: ${e?.message ?? JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
    if (e?.stack) logger.error(e.stack);
    process.exit(1);
  });
}
