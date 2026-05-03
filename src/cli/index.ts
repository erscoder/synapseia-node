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
import { ModelCatalogHelper } from '../modules/model/model-catalog';
import { LlmProviderHelper } from '../modules/llm/llm-provider';
import { CLOUD_PROVIDERS } from '../modules/llm/providers';
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
import { CONFIG_FILE } from '../modules/config/config';
import { HeartbeatHelper } from '../modules/heartbeat/heartbeat';
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

const SYPNASEIA_HEADER = `
╔════════════════════════════════════════════════════════════════════════════╗
║                                                                            ║
║  ███████╗██╗   ██╗██████╗ ███╗   ██╗ █████╗ ███████╗███████╗██╗ █████╗     ║
║  ██╔════╝╚██╗ ██╔╝██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔════╝██║██╔══██╗    ║
║  ███████╗ ╚████╔╝ ██████╔╝██╔██╗ ██║███████║███████╗█████╗  ██║███████║    ║
║  ╚════██║  ╚██╔╝  ██╔═══╝ ██║╚██╗██║██╔══██║╚════██║██╔══╝  ██║██╔══██║    ║
║  ███████║   ██║   ██║     ██║ ╚████║██║  ██║███████║███████╗██║██║  ██║    ║
║  ╚══════╝   ╚═╝   ╚═╝     ╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚═╝  ╚═╝    ║
║                                                                            ║
║                    Decentralized AI Compute Network                        ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝
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
  tier: number;
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

  const VERSION = getPackageVersion();
  const program = new Command();
  program.name('synapseia').description('Synapseia Network Node CLI').version(VERSION);

  // ── start ──────────────────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start Synapseia node')
    .option('--model <name>', 'Model to use (default: recommended for hardware)')
    .option('--llm-key <key>', 'API key for cloud LLM provider')
    .option('--coordinator <url>', 'Coordinator URL (default: http://localhost:3701)')
    .option('--max-iterations <n>', 'Maximum work order iterations (default: infinite)', parseInt)
    .option('--inference', 'Enable inference mode (expose GPU as AI inference provider)')
    .option('--inference-models <models>', 'Comma-separated list of models to serve (e.g. ollama/qwen2.5:7b,ollama/llama3:8b)')
    .option('--lat <lat>', 'Latitude for geo-location (optional)')
    .option('--lng <lng>', 'Longitude for geo-location (optional)')
    .option('--set-name', 'New node name (optional)')
    .action(
      async (options: {
        model?: string;
        llmKey?: string;
        coordinator?: string;
        maxIterations?: number;
        inference?: boolean;
        inferenceModels?: string;
        lat?: string;
        lng?: string;
      }) => {
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
        const { wallet, isNew } = await walletService.getOrCreate(nodeHome);
        const hardware = hardwareService.detect();

        if (isNew) {
          walletService.displayCreationWarning(wallet);
        }
        const coordinatorUrl = options.coordinator || config.coordinatorUrl;
        // Priority: --model flag > LLM_MODEL env > config.defaultModel
        const model = options.model || process.env.LLM_MODEL || config.defaultModel;
        const inferenceEnabled = options.inference ?? config.inferenceEnabled ?? false;
        const inferenceModels = options.inferenceModels
          ? options.inferenceModels.split(',')
          : (config.inferenceModels ?? []);
        const llmKey = options.llmKey || config.llmKey;

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
            if (isOllamaModel && hardware.tier < (selectedModel?.recommendedTier ?? 0)) {
              logger.error(
                `Error: Model '${model}' requires Tier ${selectedModel?.recommendedTier} or higher.`
              );
              logger.error(`Your hardware is Tier ${hardware.tier}.`);
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

        // ── Python3 + PyTorch check + optional install ────────────────────
        const { isPyTorchAvailable: checkTorch } = await import('../modules/model/trainer.js');
        const { execSync: execSyncFn, spawnSync } = await import('child_process');

        // Check python3 availability first
        const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
        const hasTorch = hasPython && await checkTorch();

        if (!hasTorch) {
          logger.log('\n⚡ Hyperparam Search capability detected!');
          logger.log('   Your node can run micro-transformer training to optimize');
          logger.log('   AI hyperparameters and earn SYN rewards.');
          logger.log('   This requires Python 3 + PyTorch (CPU only, no GPU needed).\n');

          // In non-interactive environments (Docker), skip PyTorch install prompt
          let installTorch: boolean | null;
          if (process.env.CI || process.env.DOCKER || !process.stdout.isTTY) {
            logger.warn('Non-interactive environment — skipping PyTorch install. Set INSTALL_TORCH=1 to auto-install.');
            installTorch = process.env.INSTALL_TORCH === '1';
          } else {
            const { confirm } = await import('@inquirer/prompts');
            installTorch = await safePrompt(() => confirm({
              message: 'Install Python3 + PyTorch now? (recommended)',
              default: true,
            }));
          }

          if (installTorch) {
            const plat = os.platform();

            // Required versions
            const REQUIRED_PYTHON_MINOR = 14;   // Python 3.14.x
            const TORCH_VERSION = '2.10.0';      // Tested and confirmed working

            // Step 1: install python3 if missing or wrong version
            const pythonVersionRaw = spawnSync('python3', ['--version'], { stdio: 'pipe' });
            const pythonVersionStr = (pythonVersionRaw.stdout?.toString() ?? '').trim(); // e.g. "Python 3.14.3"
            // S2.8: regex was /Python 3\.(\.\d+)/ which never matches
            // (literal `.` followed by `\.\d+` = `..\d+`). Result was
            // pythonMinor=0 every boot, triggering a pointless reinstall
            // each time. Fixed to capture the minor digit group only.
            const pythonMinor = parseInt(pythonVersionStr.match(/^Python 3\.(\d+)/)?.[1] ?? '0', 10);
            const hasPythonCorrect = hasPython && pythonMinor >= REQUIRED_PYTHON_MINOR;

            if (!hasPythonCorrect) {
              logger.log(`\n📦 Installing Python 3.${REQUIRED_PYTHON_MINOR}+ (current: ${pythonVersionStr || 'none'})...`);
              try {
                if (plat === 'darwin') {
                  const hasBrew = spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
                  if (hasBrew) {
                    // Install specific minor version via pyenv or brew python@3.14 formula
                    const hasPyenv = spawnSync('pyenv', ['--version'], { stdio: 'ignore' }).status === 0;
                    if (hasPyenv) {
                      execSyncFn(`pyenv install 3.${REQUIRED_PYTHON_MINOR} --skip-existing`, { stdio: 'inherit' });
                      execSyncFn(`pyenv global 3.${REQUIRED_PYTHON_MINOR}`, { stdio: 'inherit' });
                    } else {
                      // brew python@3.14 formula (may not exist yet for very new versions)
                      try {
                        execSyncFn(`brew install python@3.${REQUIRED_PYTHON_MINOR}`, { stdio: 'inherit' });
                        execSyncFn(`brew link --force python@3.${REQUIRED_PYTHON_MINOR}`, { stdio: 'inherit' });
                      } catch {
                        // fallback: install latest python3 via brew
                        execSyncFn('brew install python3', { stdio: 'inherit' });
                      }
                    }
                  } else {
                    logger.warn(`⚠️  Homebrew not found. Install Python 3.${REQUIRED_PYTHON_MINOR} from https://www.python.org/downloads/`);
                    logger.warn('   Then re-run syn start to enable Hyperparam Search.');
                    logger.log('   Continuing without Hyperparam Search...\n');
                  }
                } else if (plat === 'linux') {
                  const hasApt = spawnSync('apt-get', ['--version'], { stdio: 'ignore' }).status === 0;
                  const hasDnf = spawnSync('dnf', ['--version'], { stdio: 'ignore' }).status === 0;
                  if (hasApt) {
                    // Ubuntu/Debian: use deadsnakes PPA for specific Python versions
                    try {
                      execSyncFn(`sudo add-apt-repository -y ppa:deadsnakes/ppa`, { stdio: 'inherit' });
                      execSyncFn(`sudo apt-get update`, { stdio: 'inherit' });
                      execSyncFn(`sudo apt-get install -y python3.${REQUIRED_PYTHON_MINOR} python3.${REQUIRED_PYTHON_MINOR}-venv python3-pip`, { stdio: 'inherit' });
                      execSyncFn(`sudo update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.${REQUIRED_PYTHON_MINOR} 1`, { stdio: 'inherit' });
                    } catch {
                      execSyncFn('sudo apt-get install -y python3 python3-pip', { stdio: 'inherit' });
                    }
                  } else if (hasDnf) {
                    execSyncFn(`sudo dnf install -y python3.${REQUIRED_PYTHON_MINOR} python3-pip`, { stdio: 'inherit' });
                  } else {
                    execSyncFn('sudo pacman -S --noconfirm python python-pip', { stdio: 'inherit' });
                  }
                } else {
                  logger.warn(`⚠️  Unsupported OS. Install Python 3.${REQUIRED_PYTHON_MINOR} manually: https://www.python.org`);
                  logger.log('   Continuing without Hyperparam Search...\n');
                }
                logger.log(`✅ Python 3.${REQUIRED_PYTHON_MINOR} installed.\n`);
              } catch {
                logger.warn(`⚠️  Python 3.${REQUIRED_PYTHON_MINOR} install failed. Install manually: https://www.python.org/downloads/`);
                logger.warn('   Continuing without Hyperparam Search.\n');
              }
            }

            // Step 2: install torch==2.10.0 (CPU-only wheel, no CUDA, ~200MB)
            const pythonNow = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
            if (pythonNow) {
              // Check if correct torch version is already installed
              const torchCheck = spawnSync(
                'python3', ['-c', `import torch; assert torch.__version__ == '${TORCH_VERSION}', torch.__version__`],
                { stdio: 'pipe' }
              );
              if (torchCheck.status === 0) {
                logger.log(`✅ PyTorch ${TORCH_VERSION} already installed.\n`);
              } else {
                logger.log(`📦 Installing PyTorch ${TORCH_VERSION} (CPU-only, ~200MB)...`);
                try {
                  execSyncFn(
                    `pip3 install torch==${TORCH_VERSION} --index-url https://download.pytorch.org/whl/cpu`,
                    { stdio: 'inherit' }
                  );
                  logger.log(`✅ PyTorch ${TORCH_VERSION} installed! Your node can now run Hyperparam Search.\n`);
                } catch {
                  logger.warn(`⚠️  PyTorch install failed. Try manually: pip3 install torch==${TORCH_VERSION} --index-url https://download.pytorch.org/whl/cpu`);
                  logger.warn('   Continuing without Hyperparam Search.\n');
                }
              }
            }
          } else {
            logger.log('   Skipping. Node will start without Hyperparam Search.\n');
            logger.log('   To enable later:\n     pip3 install torch\n');
          }
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
        logger.log(`  Tier: ${hardware.tier} (${getTierName(hardware.tier)})`);
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

        // Use HeartbeatHelper as single source of truth for capabilities
        const capabilities = heartbeatHelper.determineCapabilities(hardware);
        capabilities.push(`tier-${hardware.tier}`);
        if (inferenceEnabled) capabilities.push('inference');

        // ── SYN token account activation ─────────────────────────────────────
        logger.log('\nChecking SYN token account activation...');
        const { Keypair } = await import('@solana/web3.js');
        const walletKeypair = Keypair.fromSecretKey(new Uint8Array(wallet.secretKey));
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
            tier: hardware.tier,
            coordinatorUrl,
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
            getStakedAmount(walletAddress, config.coordinatorUrl),
          ])
        : [0, 0];

      const status: StatusOutput = {
        peerId: identity?.peerId || null,
        tier: hardware.tier,
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
      logger.log(`Tier:    ${status.tier} (${getTierName(status.tier)})`);
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
    .option('--set-coordinator-url <url>', 'Set coordinator URL')
    .option('--set-model <model>', 'Set default model (provider/model format)')
    .option('--set-llm-key <key>', 'Set LLM API key')
    .option('--set-llm-url <url>', '[DEPRECATED, ignored] LLM endpoints are now hardcoded per provider')
    .action(async (options: {
      show?: boolean;
      setName?: string;
      setCoordinatorUrl?: string;
      setModel?: string;
      setLlmUrl?: string;
      setLlmKey?: string;
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

      if (options.setCoordinatorUrl) {
        config.coordinatorUrl = options.setCoordinatorUrl;
        configService.save(config);
        logger.log(`✅ Coordinator URL set to: ${options.setCoordinatorUrl}`);
        process.exit(0);
      }

      if (options.setModel) {
        if (!/^[a-zA-Z0-9_-]+\/[\w.:\-]+$/.test(options.setModel)) {
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

      logger.log('\n🔧 Synapseia Configuration Wizard');
      logger.log('   Use ↑↓ to navigate, Enter to select, Ctrl+C to cancel.\n');

      const catalog = modelCatalogService.getModelCatalog();
      const hardware = hardwareService.detect();
      const compatibleModels = hardwareService.getCompatibleModels(hardware.gpuVramGb || 0);

      const BACK = '__BACK__';

      type Step = 'coordinator' | 'modelMode' | 'modelPick' | 'llmConfig' | 'inference' | 'done';
      let step: Step = 'coordinator';
      let modelMode: string | null = null;

      while (step !== 'done') {
        if (step === 'coordinator') {
          const ans = await safePrompt(() =>
            input({
              message: 'Coordinator URL:',
              default: config.coordinatorUrl,
              validate: (v) => {
                if (!v) return 'Required';
                if (!v.startsWith('http')) return 'Must start with http:// or https://';
                return true;
              },
            })
          );
          if (ans === null) { logger.log('\nCancelled.'); return; }
          config.coordinatorUrl = ans;
          step = 'modelMode';
          continue;
        }

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
              config.defaultModel = compatibleModels[0].name;
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
                value: m.name,
                description: (m as ModelInfo).description,
              }));
            }
          }

          if (modelMode === 'all') {
            choices = catalog.map((m) => ({
              name: `${m.name}  (${m.category}, ${m.minVram}GB VRAM)`,
              value: m.name,
              description: (m as ModelInfo).description,
              disabled: m.recommendedTier > hardware.tier ? 'Requires higher tier' : false,
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
  // Non-interactive: takes password from SYNAPSEIA_WALLET_PASSWORD, tries to
  // decrypt the encrypted wallet.json, and exits 0 on success or 1 on failure.
  // Used by the desktop UI to validate the password the user typed.
  program
    .command('wallet-verify')
    .description('Validate wallet password (reads SYNAPSEIA_WALLET_PASSWORD)')
    .action(async () => {
      const envPassword = process.env.SYNAPSEIA_WALLET_PASSWORD ?? process.env.WALLET_PASSWORD;
      if (!envPassword) {
        logger.error('SYNAPSEIA_WALLET_PASSWORD env var is required for wallet-verify');
        process.exit(2);
      }
      const nodeHome = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
      const walletPath = path.join(nodeHome, 'wallet.json');
      if (!existsSync(walletPath)) {
        logger.error('WALLET_NOT_FOUND');
        process.exit(3);
      }
      try {
        const wallet = await walletService.load(nodeHome, envPassword);
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
    .option('--coordinator-url <url>', 'Coordinator URL')
    .option('--model <model>', 'Default model (provider/model)')
    .option('--llm-key <key>', 'LLM API key')
    .option('--llm-url <url>', '[DEPRECATED, ignored] Endpoints are hardcoded per provider')
    .action(async (options: {
      name?: string;
      coordinatorUrl?: string;
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
        if (options.coordinatorUrl) cfg.coordinatorUrl = options.coordinatorUrl;
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
