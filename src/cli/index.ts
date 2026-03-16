#!/usr/bin/env node
import { Command } from 'commander';
import { getOrCreateIdentity } from '../identity.js';
import { detectHardware, getSystemInfo, getCompatibleModels, getRecommendedTier, type Hardware } from '../hardware.js';
import {
  getModelCatalog,
  getModelByName,
  type ModelInfo,
  type ModelCategory
} from '../model-catalog.js';
import { parseModel, type LLMModel, type LLMConfig } from '../llm-provider.js';
import { startWorkOrderAgent, stopWorkOrderAgent, getWorkOrderAgentState } from '../work-order-agent.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import readline from 'readline';

const program = new Command();

// Config file path
const CONFIG_DIR = join(homedir(), '.synapseia');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface Config {
  coordinatorUrl: string;
  defaultModel: string;
  llmUrl?: string;
  llmKey?: string;
  wallet?: string;
}

function loadConfig(): Config {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return defaultConfig();
    }
  }
  return defaultConfig();
}

function defaultConfig(): Config {
  return {
    coordinatorUrl: 'http://localhost:3001',
    defaultModel: 'ollama/qwen2.5:0.5b',
  };
}

function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

interface IdentityOutput {
  peerId: string;
  publicKey: string;
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

program
  .name('synapseia')
  .description('SynapseIA Network Node CLI')
  .version('0.1.0');

program
  .command('start')
  .description('Start SynapseIA node')
  .option('--model <name>', 'Model to use (default: recommended for hardware)')
  .option('--llm-url <url>', 'Custom LLM API base URL (for openai-compat provider)')
  .option('--llm-key <key>', 'API key for cloud LLM provider')
  .option('--coordinator <url>', 'Coordinator URL (default: http://localhost:3001)')
  .option('--max-iterations <n>', 'Maximum work order iterations (default: infinite)', parseInt)
  .action(async (options: { 
    model?: string; 
    llmUrl?: string; 
    llmKey?: string;
    coordinator?: string;
    maxIterations?: number;
  }) => {
    const config = loadConfig();
    const identity = await getOrCreateIdentity();
    const hardware = await detectHardware();

    // Merge config with CLI options (CLI takes precedence)
    const coordinatorUrl = options.coordinator || config.coordinatorUrl;
    const model = options.model || config.defaultModel;
    const llmUrl = options.llmUrl || config.llmUrl;
    const llmKey = options.llmKey || config.llmKey;

    // Determine model to use
    let selectedModel: ModelInfo | null = null;

    if (model) {
      // User specified a model - validate it exists
      selectedModel = getModelByName(model);
      if (!selectedModel) {
        console.error(`Error: Model '${model}' not found in catalog.`);
        console.error('Available models:');
        const catalog = getModelCatalog();
        catalog.forEach((m) => {
          console.error(`  ${m.name} (${m.category}, ${m.minVram}GB VRAM)`);
        });
        process.exit(1);
      }

      // Check if model is compatible with hardware (only for ollama models)
      const isOllamaModel = model?.startsWith('ollama/') || (!model && hardware.hasOllama);
      if (isOllamaModel && hardware.tier < selectedModel.recommendedTier) {
        console.error(
          `Error: Model '${model}' requires Tier ${selectedModel.recommendedTier} or higher.`
        );
        console.error(`Your hardware is Tier ${hardware.tier}.`);
        process.exit(1);
      }

      // Check if API key is provided for cloud models
      const isCloudModel = model?.startsWith('openai-compat/') || model?.startsWith('anthropic/') || model?.startsWith('kimi/') || model?.startsWith('minimax/');
      if (isCloudModel && !llmKey) {
        console.error(`Error: Cloud model '${model}' requires --llm-key`);
        process.exit(1);
      }
    } else {
      // No model specified - use recommended model for hardware
      const compatibleModels = getCompatibleModels(hardware.gpuVramGb || 0);
      if (compatibleModels.length === 0) {
        console.error('Error: No compatible models found for your hardware.');
        console.error('Consider using cloud LLM providers with --model openai-compat/asi1-mini --llm-key <key>');
        process.exit(1);
      }
      selectedModel = compatibleModels[0];
      console.log(`Using recommended model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM)`);
    }

    console.log('Starting SynapseIA node...');
    console.log(`PeerID: ${identity.peerId}`);
    console.log(`Tier: ${hardware.tier} (${getTierName(hardware.tier)})`);
    console.log(`Ollama: ${hardware.hasOllama ? 'yes' : 'no'}`);
    console.log(`Model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM, ${selectedModel.category || 'unknown'})`);
    
    if (llmUrl) {
      console.log(`LLM URL: ${llmUrl}`);
    }

    // Parse LLM model for work order agent
    const llmModel = parseModel(model || 'ollama/qwen2.5:0.5b');
    if (!llmModel) {
      console.error(`Error: Invalid model format '${model}'`);
      process.exit(1);
    }

    // Start work order agent
    console.log('\n🚀 Starting work order agent...');
    
    const capabilities = hardware.hasOllama 
      ? ['llm', 'ollama', `tier-${hardware.tier}`]
      : ['llm', `tier-${hardware.tier}`];

    await startWorkOrderAgent({
      coordinatorUrl: coordinatorUrl,
      peerId: identity.peerId,
      capabilities,
      llmModel,
      llmConfig: {
        apiKey: llmKey,
        baseUrl: llmUrl,
      },
      intervalMs: 30000, // 30 seconds
      maxIterations: options.maxIterations,
    });
  });

program
  .command('status')
  .description('Show node status')
  .action(async () => {
    const identity = getOrCreateIdentity();
    const hardware = await detectHardware();

    const status: StatusOutput = {
      peerId: identity?.peerId || null,
      tier: hardware.tier,
      wallet: 'not connected', // TODO: connect wallet
      balance: 0, // TODO: fetch SYN balance
      staked: 0, // TODO: fetch staked amount
      hasOllama: hardware.hasOllama,
      cpuCores: hardware.cpuCores,
      ramGb: hardware.ramGb,
      gpuVramGb: hardware.gpuVramGb,
    };

    console.log('Node Status:');
    console.log(`PeerID:  ${status.peerId || 'Not initialized'}`);
    console.log(`Tier:    ${status.tier} (${getTierName(status.tier as any)})`);
    console.log(`Wallet:  ${status.wallet}`);
    console.log(`Balance: ${status.balance} SYN`);
    console.log(`Staked:  ${status.staked} SYN`);
    console.log(`Hardware: ${status.cpuCores} cores, ${status.ramGb}GB RAM, ${status.gpuVramGb}GB VRAM`);
    console.log(`Ollama:  ${status.hasOllama ? 'Running' : 'Not detected'}`);
  });

program
  .command('stake')
  .description('Stake SYN tokens')
  .argument('<amount>', 'Amount to stake (in SYN tokens)')
  .action(async (amount: string) => {
    console.log(`Staking ${amount} SYN...`);
    // TODO: Call staking program on Devnet
    console.log('Tx hash: <placeholder>'); // Will replace with actual tx hash
  });

program
  .command('unstake')
  .description('Unstake SYN tokens')
  .argument('<amount>', 'Amount to unstake (in SYN tokens)')
  .action(async (amount: string) => {
    console.log(`Unstaking ${amount} SYN...`);
    // TODO: Call unstake program on Devnet
    console.log('Tx hash: <placeholder>'); // Will replace with actual tx hash
  });

program
  .command('system-info')
  .description('Show detailed system information')
  .action(async () => {
    const sysInfo = getSystemInfo();
    const recommendedTier = getRecommendedTier(sysInfo.gpu.vramGb);
    const compatibleModels = getCompatibleModels(sysInfo.gpu.vramGb);

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
    const tierName = ['CPU-Only', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'][recommendedTier] || 'Unknown';
    console.log(`   Recommended Tier: ${recommendedTier} (${tierName})`);
    console.log();
    console.log('🤖 Compatible Models:');
    if (compatibleModels.length > 0) {
      console.log(`   Found ${compatibleModels.length} models compatible with ${sysInfo.gpu.vramGb}GB VRAM:`);
      compatibleModels.forEach((model, index) => {
        const tierName = ['CPU', 'T1', 'T2', 'T3', 'T4', 'T5'][model.recommendedTier] || 'Unknown';
        console.log(`   ${index + 1}. ${model.name.padEnd(30)} (min ${model.minVram}GB, rec ${tierName})`);
      });
    } else {
      console.log('   No compatible models found. Consider upgrading GPU or using cloud LLM.');
    }
    console.log();
    console.log('═══════════════════════════════════════════════════');
  });

program
  .command('stop')
  .description('Stop the running SynapseIA node')
  .action(() => {
    console.log('🛑 Stopping SynapseIA node...');
    stopWorkOrderAgent();
    console.log('✅ Node stopped');
  });

program
  .command('config')
  .description('Interactive configuration wizard')
  .option('--show', 'Show current configuration')
  .action(async (options: { show?: boolean }) => {
    const config = loadConfig();

    if (options.show) {
      console.log('Current configuration:');
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer));
      });
    };

    console.log('🔧 SynapseIA Configuration Wizard');
    console.log('Press Enter to keep current value\n');

    const coordinatorUrl = await ask(`Coordinator URL [${config.coordinatorUrl}]: `);
    if (coordinatorUrl) config.coordinatorUrl = coordinatorUrl;

    const defaultModel = await ask(`Default model [${config.defaultModel}]: `);
    if (defaultModel) config.defaultModel = defaultModel;

    const llmUrl = await ask(`Custom LLM URL (optional) [${config.llmUrl || ''}]: `);
    config.llmUrl = llmUrl || undefined;

    const llmKey = await ask(`LLM API key (optional) [${config.llmKey ? '***' : ''}]: `);
    if (llmKey) config.llmKey = llmKey;

    rl.close();

    saveConfig(config);
    console.log('\n✅ Configuration saved to', CONFIG_FILE);
  });

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

program.parse();
