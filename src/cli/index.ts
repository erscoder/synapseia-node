#!/usr/bin/env node
import { Command } from 'commander';
import { getOrCreateIdentity } from '../identity.js';
import { getOrCreateWallet, getWalletAddress, displayWalletCreationWarning, SolanaWallet } from '../wallet.js';
import { detectHardware, getSystemInfo, getCompatibleModels, getRecommendedTier, type Hardware } from '../hardware.js';
import {
  getModelCatalog,
  getModelByName,
  type ModelInfo,
  type ModelCategory
} from '../model-catalog.js';
import { parseModel, type LLMModel, type LLMConfig } from '../llm-provider.js';
import { startWorkOrderAgent, stopWorkOrderAgent, getWorkOrderAgentState } from '../work-order-agent.js';
import { input, select, confirm, password } from '@inquirer/prompts';
import { loadConfig, saveConfig, defaultConfig, validateCoordinatorUrl, isCloudModel, Config, CONFIG_FILE } from '../config.js';

// ASCII Art Header
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

const program = new Command();

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
    const { wallet, isNew } = await getOrCreateWallet();
    const hardware = await detectHardware();

    // Show wallet creation warning if this is a new wallet
    if (isNew) {
      displayWalletCreationWarning(wallet);
    }

    // Merge config with CLI options (CLI takes precedence)
    const coordinatorUrl = options.coordinator || config.coordinatorUrl;
    const model = options.model || config.defaultModel;
    const llmUrl = options.llmUrl || config.llmUrl;
    const llmKey = options.llmKey || config.llmKey;

    // Determine model to use
    let selectedModel: ModelInfo | null = null;

    if (model) {
      // Determine if this is a cloud model before catalog lookup
      const isCloudModel = model?.startsWith('openai-compat/') || model?.startsWith('anthropic/') || model?.startsWith('kimi/') || model?.startsWith('minimax/');

      if (!isCloudModel) {
        // Local model - validate it exists in catalog
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
      }

      // Check if API key is provided for cloud models
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

    // Display awesome header
    console.log(SYPNASEIA_HEADER);
    console.log('Starting SYPNASEIA node...');
    console.log(`PeerID: ${identity.peerId}`);
    console.log(`Wallet: ${wallet.publicKey} (Solana devnet)`);
    console.log(`Tier: ${hardware.tier} (${getTierName(hardware.tier)})`);
    console.log(`Ollama: ${hardware.hasOllama ? 'yes' : 'no'}`);
    if (selectedModel) {
      console.log(`Model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM, ${selectedModel.category || 'unknown'})`);
    } else {
      console.log(`Model: ${model} (cloud)`);
    };
    
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

    // Get wallet address (doesn't require password)
    const walletAddress = getWalletAddress();

    const status: StatusOutput = {
      peerId: identity?.peerId || null,
      tier: hardware.tier,
      wallet: walletAddress,
      balance: 0, // TODO: fetch SYN balance
      staked: 0, // TODO: fetch staked amount
      hasOllama: hardware.hasOllama,
      cpuCores: hardware.cpuCores,
      ramGb: hardware.ramGb,
      gpuVramGb: hardware.gpuVramGb,
    };

    console.log(SYPNASEIA_HEADER);
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

    console.log('🔧 SynapseIA Configuration Wizard\n');

    // Coordinator URL
    const coordinatorUrl = await input({
      message: 'Coordinator URL:',
      default: config.coordinatorUrl,
      validate: (value) => {
        if (!value) return 'Coordinator URL is required';
        if (!value.startsWith('http')) return 'URL must start with http:// or https://';
        return true;
      },
    });
    config.coordinatorUrl = coordinatorUrl;

    // Model selection
    const catalog = getModelCatalog();
    const hardware = await detectHardware();
    const compatibleModels = getCompatibleModels(hardware.gpuVramGb || 0);

    const modelChoices = [
      { name: 'Use recommended model for your hardware', value: 'recommended' },
      { name: 'Select from compatible models', value: 'compatible' },
      { name: 'Select from all models', value: 'all' },
      { name: 'Use cloud LLM provider', value: 'cloud' },
    ];

    const modelSelectionMode = await select({
      message: 'How would you like to configure your LLM model?',
      choices: modelChoices,
    });

    if (modelSelectionMode === 'recommended') {
      if (compatibleModels.length > 0) {
        config.defaultModel = compatibleModels[0].name;
        console.log(`✓ Selected recommended model: ${config.defaultModel}`);
      } else {
        console.log('⚠ No compatible local models found. Please select a cloud provider.');
        const cloudModel = await select({
          message: 'Select cloud LLM provider:',
          choices: [
            { name: 'ASI1 Mini (openai-compat)', value: 'openai-compat/asi1-mini' },
            { name: 'ASI1 (openai-compat)', value: 'openai-compat/asi1' },
            { name: 'Custom OpenAI-compatible', value: 'custom' },
          ],
        });
        config.defaultModel = cloudModel === 'custom' ? 'openai-compat/custom' : cloudModel;
      }
    } else if (modelSelectionMode === 'compatible') {
      if (compatibleModels.length === 0) {
        console.log('⚠ No compatible models found for your hardware.');
        const useCloud = await confirm({
          message: 'Would you like to use a cloud LLM provider instead?',
          default: true,
        });
        if (useCloud) {
          const cloudModel = await select({
            message: 'Select cloud LLM provider:',
            choices: [
              { name: 'ASI1 Mini', value: 'openai-compat/asi1-mini' },
              { name: 'ASI1', value: 'openai-compat/asi1' },
            ],
          });
          config.defaultModel = cloudModel;
        } else {
          console.log('Skipping model configuration.');
        }
      } else {
        const modelChoices = compatibleModels.map((m) => ({
          name: `${m.name} (${m.minVram}GB VRAM, Tier ${m.recommendedTier})`,
          value: m.name,
          description: (m as ModelInfo).description,
        }));
        const selectedModel = await select({
          message: 'Select a model:',
          choices: modelChoices,
        });
        config.defaultModel = selectedModel;
      }
    } else if (modelSelectionMode === 'all') {
      const allModelChoices = catalog.map((m) => ({
        name: `${m.name} (${m.category}, ${m.minVram}GB VRAM)`,
        value: m.name,
        description: (m as ModelInfo).description,
        disabled: m.recommendedTier > hardware.tier ? 'Requires higher tier hardware' : false,
      }));
      const selectedModel = await select({
        message: 'Select a model (⚠ some may not work with your hardware):',
        choices: allModelChoices,
      });
      config.defaultModel = selectedModel;
    } else if (modelSelectionMode === 'cloud') {
      const cloudChoices = [
        { name: 'ASI1 Mini', value: 'openai-compat/asi1-mini', description: 'Smaller, faster model' },
        { name: 'ASI1', value: 'openai-compat/asi1', description: 'Full ASI1 model' },
        { name: 'Custom OpenAI-compatible endpoint', value: 'openai-compat/custom', description: 'Use your own endpoint' },
      ];
      const cloudModel = await select({
        message: 'Select cloud LLM provider:',
        choices: cloudChoices,
      });
      config.defaultModel = cloudModel;
    }

    // Cloud LLM configuration if using cloud provider
    const usingCloudModel = isCloudModel(config.defaultModel);
    if (usingCloudModel) {
      console.log('\n☁️ Cloud LLM Configuration');
      
      const llmUrl = await input({
        message: 'LLM API base URL:',
        default: config.llmUrl || 'https://api.asi1.ai',
        validate: (value) => {
          if (!value) return 'URL is required for cloud models';
          if (!value.startsWith('http')) return 'URL must start with http:// or https://';
          return true;
        },
      });
      config.llmUrl = llmUrl;

      const hasApiKey = await confirm({
        message: 'Do you have an API key?',
        default: true,
      });

      if (hasApiKey) {
        const llmKey = await password({
          message: 'Enter your API key:',
          mask: '*',
        });
        if (llmKey) config.llmKey = llmKey;
      } else {
        console.log('⚠ You will need to provide --llm-key when starting the node.');
      }
    } else {
      // Local models - optional custom URL for Ollama
      const useCustomOllama = await confirm({
        message: 'Use custom Ollama URL?',
        default: !!config.llmUrl,
      });
      if (useCustomOllama) {
        const ollamaUrl = await input({
          message: 'Ollama URL:',
          default: config.llmUrl || 'http://localhost:11434',
        });
        config.llmUrl = ollamaUrl;
      } else {
        config.llmUrl = undefined;
      }
    }

    saveConfig(config);
    console.log('\n✅ Configuration saved to', CONFIG_FILE);
    console.log('\nNext steps:');
    console.log('  synapseia start     # Start the node with your configuration');
    console.log('  synapseia status    # Check node status');
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
