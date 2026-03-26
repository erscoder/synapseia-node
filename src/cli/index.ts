#!/usr/bin/env node
// Load .env before anything else — must be first import
import 'dotenv/config';
import logger from '../utils/logger.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { AppModule } from '../app.module.js';
import { IdentityService } from '../modules/identity/services/identity.service.js';
import { HardwareService } from '../modules/hardware/services/hardware.service.js';
import { NodeConfigService } from '../modules/config/services/node-config.service.js';
import { WalletService } from '../modules/wallet/services/wallet.service.js';
import { ModelCatalogService } from '../modules/model/services/model-catalog.service.js';
import { LlmService } from '../modules/llm/services/llm.service.js';
import { WorkOrderAgentService } from '../modules/agent/services/work-order-agent.service.js';
import { P2pService } from '../modules/p2p/services/p2p.service.js';
import { startNode } from '../node-runtime.js';
import { input, select, confirm, password } from '@inquirer/prompts';
import { getSynBalance, getStakedAmount } from '../modules/wallet/solana-balance.js';
import { stakeTokens, unstakeTokens, claimStakingRewards, getStakeInfo, depositSol, depositSyn, withdrawSol, withdrawSyn, getWalletBalance } from '../modules/staking/staking-cli.js';
import type { ModelInfo, HardwareTier } from '../modules/hardware/hardware.js';
import { CONFIG_FILE } from '../modules/config/config.js';

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
  logger.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  if (isExitError(reason)) {
    logger.log('\nBye 👋');
    process.exit(0);
  }
  logger.error(reason);
  process.exit(1);
});

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
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
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
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  const identityService = app.get(IdentityService);
  const hardwareService = app.get(HardwareService);
  const configService = app.get(NodeConfigService);
  const walletService = app.get(WalletService);
  const modelCatalogService = app.get(ModelCatalogService);
  const llmService = app.get(LlmService);
  const workOrderAgentService = app.get(WorkOrderAgentService);
  const p2pService = app.get(P2pService);

  const VERSION = getPackageVersion();
  const program = new Command();
  program.name('synapseia').description('SynapseIA Network Node CLI').version(VERSION);

  // ── start ──────────────────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start SynapseIA node')
    .option('--model <name>', 'Model to use (default: recommended for hardware)')
    .option('--llm-url <url>', 'Custom LLM API base URL (for openai-compat provider)')
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
        llmUrl?: string;
        llmKey?: string;
        coordinator?: string;
        maxIterations?: number;
        inference?: boolean;
        inferenceModels?: string;
        lat?: string;
        lng?: string;
      }) => {
        const config = configService.load();
        // Pass SYNAPSEIA_HOME so each node uses its own wallet dir
        const nodeHome = process.env.SYNAPSEIA_HOME;

        // Check if identity exists; if not, prompt for a name
        let nodeName: string | undefined;
        const identityDir = nodeHome ?? path.join(os.homedir(), '.synapseia');
        if (!existsSync(path.join(identityDir, 'identity.json'))) {
          const { input } = await import('@inquirer/prompts');
          nodeName = await input({
            message: 'Choose a name for this node (e.g. "node-alpha"):',
            validate: (v: string) => v.trim().length > 0 || 'Name cannot be empty',
          });
          nodeName = nodeName.trim();
        }

        const identity = identityService.getOrCreate(nodeHome, nodeName);
        const { wallet, isNew } = await walletService.getOrCreate(nodeHome);
        const hardware = hardwareService.detect();

        if (isNew) {
          walletService.displayCreationWarning(wallet);
        }
        const coordinatorUrl = options.coordinator || config.coordinatorUrl;
        const model = config.defaultModel || options.model;
        const inferenceEnabled = options.inference ?? config.inferenceEnabled ?? false;
        const inferenceModels = options.inferenceModels
          ? options.inferenceModels.split(',')
          : (config.inferenceModels ?? []);
        const llmUrl = options.llmUrl || config.llmUrl;
        const llmKey = options.llmKey || config.llmKey;

        let selectedModel: ModelInfo | null = null;
        if (model) {
          const isCloud =
            model?.startsWith('openai-compat/') ||
            model?.startsWith('anthropic/') ||
            model?.startsWith('moonshot/') ||
            model?.startsWith('kimi/') ||
            model?.startsWith('minimax/');

          if (!isCloud) {
            selectedModel = modelCatalogService.getByName(model);
            if (!selectedModel) {
              logger.error(`Error: Model '${model}' not found in catalog.`);
              logger.error('Available models:');
              modelCatalogService.getCatalog().forEach((m) => {
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
            logger.error('Error: No compatible models found for your hardware.');
            logger.error(
              'Consider using cloud LLM providers with --model openai-compat/asi1-mini --llm-key <key>'
            );
            process.exit(1);
          }
          selectedModel = compatibleModels[0];
          logger.log(
            `Using recommended model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM)`
          );
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
        if (llmUrl) logger.log(`LLM URL: ${llmUrl}`);
        if (inferenceEnabled) {
          const modelsStr = inferenceModels.length > 0 ? inferenceModels.join(', ') : 'auto-detect from Ollama';
          logger.log(`Inference: ENABLED  models: ${modelsStr}`);
        }

        const llmModel = llmService.parse(model || 'ollama/qwen2.5:0.5b');
        if (!llmModel) {
          logger.error(`Error: Invalid model format '${model}'`);
          process.exit(1);
        }

        // cpu_inference is always enabled: tokenize/embedding have no LLM dependency,
        // classify falls back gracefully if no model available.
        const capabilities = hardware.hasOllama
          ? ['llm', 'ollama', 'cpu_inference', `tier-${hardware.tier}`]
          : ['llm', 'cpu_inference', `tier-${hardware.tier}`];
        if (inferenceEnabled) capabilities.push('inference');

        // ── Hand off to the node runtime ──────────────────────────────────
        const runtime = await startNode(
          {
            identity,
            name: config.name || identity.name || 'unnamed',
            walletAddress: wallet.publicKey,
            tier: hardware.tier,
            coordinatorUrl,
            capabilities,
            llmModel,
            llmConfig: { apiKey: llmKey, baseUrl: llmUrl },
            intervalMs: 30000,
            maxIterations: options.maxIterations,
            lat: config.lat,
            lng: config.lng,
          },
          { p2pService, workOrderAgentService },
        );

        process.on('SIGINT', async () => {
          await runtime.stop();
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
      logger.log('       SynapseIA Node - System Information');
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

  // ── stop ───────────────────────────────────────────────────────────────────
  program
    .command('stop')
    .description('Stop the running SynapseIA node')
    .action(() => {
      logger.log('🛑 Stopping SynapseIA node...');
      workOrderAgentService.stop();
      logger.log('✅ Node stopped');
    });

  // ── config ─────────────────────────────────────────────────────────────────
  program
    .command('config')
    .description('Interactive configuration wizard')
    .option('--show', 'Show current configuration')
    .option('--set-name <name>', 'Set node name')
    .action(async (options: { show?: boolean; setName?: string }) => {
      const configService = app.get(NodeConfigService);
      
      const config = configService.load();
      if (options.show) {
        logger.log('Current configuration:');
        logger.log(JSON.stringify(config, null, 2));
        return;
      }

      if (options.setName) {
        config.name = options.setName;
        configService.save(config);
        logger.log(`✅ Node name set to: ${options.setName}`);
        return;
      }

      logger.log('\n🔧 SynapseIA Configuration Wizard');
      logger.log('   Use ↑↓ to navigate, Enter to select, Ctrl+C to cancel.\n');

      const catalog = modelCatalogService.getCatalog();
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
            choices = [
              { name: 'Minimax', value: 'minimax/MiniMax-M2.7', description: 'MiniMax model' },
              { name: 'ASI1', value: 'openai-compat/asi1', description: 'ASI1 model' },
              {
                name: 'Custom OpenAI-compatible URL',
                value: 'openai-compat/custom',
                description: 'Bring your own endpoint',
              },
            ];
          }

          const ans = await safePrompt(() =>
            select({
              message: modelMode === 'cloud' ? 'Select cloud LLM provider:' : 'Select a model:',
              choices: [...choices, { name: '← Back  (change model type)', value: BACK }],
            })
          );
          if (ans === null) { logger.log('\nCancelled.'); return; }
          if (ans === BACK) { step = 'modelMode'; continue; }
          config.defaultModel = ans;
          step = 'llmConfig';
          continue;
        }

        if (step === 'llmConfig') {
          const usingCloud = configService.isCloudModel(config.defaultModel);
          if (usingCloud) {
            logger.log('\n  ☁️  Cloud LLM configuration, url: ', config.llmUrl);
            const llmUrl = await safePrompt(() =>
              input({
                message: 'API base URL:',
                default: config.llmUrl || 'https://api.asi1.ai/v1',
                validate: (v) => {
                  if (!v) return 'Required';
                  if (!v.startsWith('http')) return 'Must start with http';
                  return true;
                },
              })
            );
            if (llmUrl === null) { logger.log('\nCancelled.'); return; }
            config.llmUrl = llmUrl;

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
          } else {
            const useCustom = await safePrompt(() =>
              confirm({
                message: 'Use a custom Ollama URL?',
                default: !!config.llmUrl,
              })
            );
            if (useCustom === null) { logger.log('\nCancelled.'); return; }
            if (useCustom) {
              const ollamaUrl = await safePrompt(() =>
                input({
                  message: 'Ollama URL:',
                  default: config.llmUrl || 'http://localhost:11434',
                })
              );
              if (ollamaUrl === null) { logger.log('\nCancelled.'); return; }
              config.llmUrl = ollamaUrl;
            } else {
              config.llmUrl = undefined;
            }
          }
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

  program.parse();
}

bootstrap().catch((err) => {
  logger.error(err);
  process.exit(1);
});
