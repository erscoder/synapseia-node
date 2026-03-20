#!/usr/bin/env node
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AppModule } from '../app.module.js';
import { IdentityService } from '../modules/identity/identity.service.js';
import { HardwareService } from '../modules/hardware/hardware.service.js';
import { NodeConfigService } from '../modules/config/node-config.service.js';
import { WalletService } from '../modules/wallet/wallet.service.js';
import { ModelCatalogService } from '../modules/model/model-catalog.service.js';
import { LlmService } from '../modules/llm/llm.service.js';
import { WorkOrderAgentService } from '../modules/agent/work-order-agent.service.js';
import { input, select, confirm, password } from '@inquirer/prompts';
import { getSynBalance, getStakedAmount } from '../solana-balance.js';
import type { ModelInfo, HardwareTier } from '../hardware.js';
import { CONFIG_FILE } from '../config.js';

// ── Global SIGINT handler ────────────────────────────────────────────────────
function isExitError(e: unknown): boolean {
  const err = e as { constructor?: { name?: string }; message?: string };
  return err?.constructor?.name === 'ExitPromptError' || !!err?.message?.includes('force closed');
}
process.on('uncaughtException', (err: unknown) => {
  if (isExitError(err)) {
    console.log('\nBye 👋');
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  if (isExitError(reason)) {
    console.log('\nBye 👋');
    process.exit(0);
  }
  console.error(reason);
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
    .option('--coordinator <url>', 'Coordinator URL (default: http://localhost:3001)')
    .option('--max-iterations <n>', 'Maximum work order iterations (default: infinite)', parseInt)
    .action(
      async (options: {
        model?: string;
        llmUrl?: string;
        llmKey?: string;
        coordinator?: string;
        maxIterations?: number;
      }) => {
        const config = configService.load();
        const identity = identityService.getOrCreate();
        const { wallet, isNew } = await walletService.getOrCreate();
        const hardware = hardwareService.detect();

        if (isNew) {
          walletService.displayCreationWarning(wallet);
        }

        const coordinatorUrl = options.coordinator || config.coordinatorUrl;
        const model = options.model || config.defaultModel;
        const llmUrl = options.llmUrl || config.llmUrl;
        const llmKey = options.llmKey || config.llmKey;

        let selectedModel: ModelInfo | null = null;

        if (model) {
          const isCloud =
            model?.startsWith('openai-compat/') ||
            model?.startsWith('anthropic/') ||
            model?.startsWith('kimi/') ||
            model?.startsWith('minimax/');

          if (!isCloud) {
            selectedModel = modelCatalogService.getByName(model);
            if (!selectedModel) {
              console.error(`Error: Model '${model}' not found in catalog.`);
              console.error('Available models:');
              modelCatalogService.getCatalog().forEach((m) => {
                console.error(`  ${m.name} (${m.category}, ${m.minVram}GB VRAM)`);
              });
              process.exit(1);
            }

            const isOllamaModel = model?.startsWith('ollama/') || (!model && hardware.hasOllama);
            if (isOllamaModel && hardware.tier < (selectedModel?.recommendedTier ?? 0)) {
              console.error(
                `Error: Model '${model}' requires Tier ${selectedModel?.recommendedTier} or higher.`
              );
              console.error(`Your hardware is Tier ${hardware.tier}.`);
              process.exit(1);
            }
          }

          if (isCloud && !llmKey) {
            console.error(`Error: Cloud model '${model}' requires --llm-key`);
            process.exit(1);
          }
        } else {
          const compatibleModels = hardwareService.getCompatibleModels(hardware.gpuVramGb || 0);
          if (compatibleModels.length === 0) {
            console.error('Error: No compatible models found for your hardware.');
            console.error(
              'Consider using cloud LLM providers with --model openai-compat/asi1-mini --llm-key <key>'
            );
            process.exit(1);
          }
          selectedModel = compatibleModels[0];
          console.log(
            `Using recommended model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM)`
          );
        }

        console.log(SYPNASEIA_HEADER);
        console.log('Starting SYPNASEIA node...');
        console.log(`PeerID: ${identity.peerId}`);
        console.log(`Wallet: ${wallet.publicKey} (Solana devnet)`);
        console.log(`Tier: ${hardware.tier} (${getTierName(hardware.tier)})`);
        console.log(`Ollama: ${hardware.hasOllama ? 'yes' : 'no'}`);
        if (selectedModel) {
          console.log(
            `Model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM, ${selectedModel.category || 'unknown'})`
          );
        } else {
          console.log(`Model: ${model} (cloud)`);
        }
        if (llmUrl) console.log(`LLM URL: ${llmUrl}`);

        const llmModel = llmService.parse(model || 'ollama/qwen2.5:0.5b');
        if (!llmModel) {
          console.error(`Error: Invalid model format '${model}'`);
          process.exit(1);
        }

        console.log('\n🚀 Starting work order agent...');

        const capabilities = hardware.hasOllama
          ? ['llm', 'ollama', `tier-${hardware.tier}`]
          : ['llm', `tier-${hardware.tier}`];

        await workOrderAgentService.start({
          coordinatorUrl,
          peerId: identity.peerId,
          capabilities,
          llmModel,
          llmConfig: { apiKey: llmKey, baseUrl: llmUrl },
          intervalMs: 30000,
          maxIterations: options.maxIterations,
        });
      }
    );

  // ── status ─────────────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show node status')
    .action(async () => {
      const identity = identityService.getOrCreate();
      const hardware = hardwareService.detect();
      const walletAddress = walletService.getAddress();
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

      console.log(SYPNASEIA_HEADER);
      console.log('Node Status:');
      console.log(`PeerID:  ${status.peerId || 'Not initialized'}`);
      console.log(`Tier:    ${status.tier} (${getTierName(status.tier)})`);
      console.log(`Wallet:  ${status.wallet}`);
      console.log(`Balance: ${status.balance} SYN`);
      console.log(`Staked:  ${status.staked} SYN`);
      console.log(
        `Hardware: ${status.cpuCores} cores, ${status.ramGb}GB RAM, ${status.gpuVramGb}GB VRAM`
      );
      console.log(`Ollama:  ${status.hasOllama ? 'Running' : 'Not detected'}`);
    });

  // ── stake ──────────────────────────────────────────────────────────────────
  program
    .command('stake')
    .description('Stake SYN tokens')
    .argument('<amount>', 'Amount to stake (in SYN tokens)')
    .action(async (amount: string) => {
      console.log(`Staking ${amount} SYN...`);
      console.log('Tx hash: <placeholder>');
    });

  program
    .command('unstake')
    .description('Unstake SYN tokens')
    .argument('<amount>', 'Amount to unstake (in SYN tokens)')
    .action(async (amount: string) => {
      console.log(`Unstaking ${amount} SYN...`);
      console.log('Tx hash: <placeholder>');
    });

  // ── system-info ────────────────────────────────────────────────────────────
  program
    .command('system-info')
    .description('Show detailed system information')
    .action(async () => {
      const sysInfo = hardwareService.getSystemInfo();
      const recommendedTier = hardwareService.getRecommendedTier(sysInfo.gpu.vramGb);
      const compatibleModels = hardwareService.getCompatibleModels(sysInfo.gpu.vramGb);

      console.log('═══════════════════════════════════════════════════');
      console.log('       SynapseIA Node - System Information');
      console.log('═══════════════════════════════════════════════════');
      console.log();
      console.log('📋 Operating System:');
      console.log(`   ${sysInfo.os}`);
      console.log();
      console.log('🔧 CPU Information:');
      console.log(`   Model: ${sysInfo.cpu.model}`);
      console.log(`   Cores: ${sysInfo.cpu.cores}`);
      console.log();
      console.log('💾 Memory:');
      console.log(`   Total RAM: ${sysInfo.memory.totalGb} GB`);
      console.log();
      console.log('🎮 GPU Information:');
      if (sysInfo.gpu.type) {
        console.log(`   Type: ${sysInfo.gpu.type}`);
        console.log(`   VRAM: ${sysInfo.gpu.vramGb} GB`);
      } else {
        console.log('   No GPU detected');
      }
      console.log();
      console.log('🎯 Hardware Tier Assessment:');
      const tierName =
        ['CPU-Only', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'][recommendedTier] ||
        'Unknown';
      console.log(`   Recommended Tier: ${recommendedTier} (${tierName})`);
      console.log();
      console.log('🤖 Compatible Models:');
      if (compatibleModels.length > 0) {
        console.log(
          `   Found ${compatibleModels.length} models compatible with ${sysInfo.gpu.vramGb}GB VRAM:`
        );
        compatibleModels.forEach((model, index) => {
          const tName = ['CPU', 'T1', 'T2', 'T3', 'T4', 'T5'][model.recommendedTier] || 'Unknown';
          console.log(
            `   ${index + 1}. ${model.name.padEnd(30)} (min ${model.minVram}GB, rec ${tName})`
          );
        });
      } else {
        console.log('   No compatible models found. Consider upgrading GPU or using cloud LLM.');
      }
      console.log();
      console.log('═══════════════════════════════════════════════════');
    });

  // ── stop ───────────────────────────────────────────────────────────────────
  program
    .command('stop')
    .description('Stop the running SynapseIA node')
    .action(() => {
      console.log('🛑 Stopping SynapseIA node...');
      workOrderAgentService.stop();
      console.log('✅ Node stopped');
    });

  // ── config ─────────────────────────────────────────────────────────────────
  program
    .command('config')
    .description('Interactive configuration wizard')
    .option('--show', 'Show current configuration')
    .action(async (options: { show?: boolean }) => {
      const config = configService.load();

      if (options.show) {
        console.log('Current configuration:');
        console.log(JSON.stringify(config, null, 2));
        return;
      }

      console.log('\n🔧 SynapseIA Configuration Wizard');
      console.log('   Use ↑↓ to navigate, Enter to select, Ctrl+C to cancel.\n');

      const catalog = modelCatalogService.getCatalog();
      const hardware = hardwareService.detect();
      const compatibleModels = hardwareService.getCompatibleModels(hardware.gpuVramGb || 0);

      const BACK = '__BACK__';

      type Step = 'coordinator' | 'modelMode' | 'modelPick' | 'llmConfig' | 'done';
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
          if (ans === null) { console.log('\nCancelled.'); return; }
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
          if (ans === null) { console.log('\nCancelled.'); return; }
          modelMode = ans;

          if (modelMode === 'recommended') {
            if (compatibleModels.length > 0) {
              config.defaultModel = compatibleModels[0].name;
              console.log(`  ✓ Recommended model: ${config.defaultModel}`);
              step = 'llmConfig';
            } else {
              console.log('  ⚠ No compatible local models — switching to cloud picker.');
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
              console.log('  ⚠ No compatible models for your hardware — showing cloud options.');
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
          if (ans === null) { console.log('\nCancelled.'); return; }
          if (ans === BACK) { step = 'modelMode'; continue; }
          config.defaultModel = ans;
          step = 'llmConfig';
          continue;
        }

        if (step === 'llmConfig') {
          const usingCloud = configService.isCloudModel(config.defaultModel);
          if (usingCloud) {
            console.log('\n  ☁️  Cloud LLM configuration');
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
            if (llmUrl === null) { console.log('\nCancelled.'); return; }
            config.llmUrl = llmUrl;

            const hasKey = await safePrompt(() =>
              confirm({ message: 'Do you have an API key?', default: true })
            );
            if (hasKey === null) { console.log('\nCancelled.'); return; }
            if (hasKey) {
              const llmKey = await safePrompt(() =>
                password({ message: 'Enter your API key:', mask: '*' })
              );
              if (llmKey === null) { console.log('\nCancelled.'); return; }
              if (llmKey) config.llmKey = llmKey;
            } else {
              console.log('  ⚠ Provide --llm-key when starting the node.');
            }
          } else {
            const useCustom = await safePrompt(() =>
              confirm({
                message: 'Use a custom Ollama URL?',
                default: !!config.llmUrl,
              })
            );
            if (useCustom === null) { console.log('\nCancelled.'); return; }
            if (useCustom) {
              const ollamaUrl = await safePrompt(() =>
                input({
                  message: 'Ollama URL:',
                  default: config.llmUrl || 'http://localhost:11434',
                })
              );
              if (ollamaUrl === null) { console.log('\nCancelled.'); return; }
              config.llmUrl = ollamaUrl;
            } else {
              config.llmUrl = undefined;
            }
          }
          step = 'done';
        }
      }

      configService.save(config);
      console.log('\n  ✅  Configuration saved to', CONFIG_FILE);
      console.log('\n  Next steps:');
      console.log('    synapseia start    # Start the node');
      console.log('    synapseia status   # Check node status');
    });

  program.parse();
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
