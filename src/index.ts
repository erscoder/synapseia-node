#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { generateIdentity, loadIdentity, getAgentProfile } from './modules/identity/identity';
import { detectHardware, getTierName, type HardwareTier } from './modules/hardware/hardware';
import { startPeriodicHeartbeat } from './modules/heartbeat/heartbeat';
import { createP2PNode } from './modules/p2p/p2p';
import { AgentLoopHelper, type AgentLoopConfig } from './modules/agent/agent-loop';
import { generateLLM, type LLMModel, type LLMProvider, type CloudProviderId } from './modules/llm/llm-provider';
import logger from './utils/logger';

const program = new Command();

program
  .name('synapse')
  .description('Synapse Node CLI — Join the decentralized compute network')
  .version('0.0.1');

program
  .command('start')
  .description('Start Synapse node and begin autonomous research')
  .option('--model <string>', 'LLM model to use (e.g., ollama/qwen2.5:0.5b, anthropic/sonnet-4.6, kimi/k2.5)')
  .option('--dataset <string>', 'Path to training dataset')
  .option('--coordinator <string>', 'Coordinator URL')
  .option('--interval <number>', 'Research loop interval (ms)')
  .option('--max-iterations <number>', 'Max research iterations')
  .option('--interval-ms <number>', 'Heartbeat interval (ms)')
  .option('--inference', 'Enable inference capability (requires GPU)')
  .option('--cpu', 'Only use CPU (no GPU)')
  .action(async (options) => {
    logger.log('🧠 Synapse Node CLI');
    logger.log('');

    // Set defaults
    const datasetPath = options.dataset || path.join(process.cwd(), 'data', 'astro-sample.txt');
    const coordinatorUrl = options.coordinator || 'http://localhost:3701';
    const interval = options.interval || 120000;
    const maxIterations = options.maxIterations || 0;
    const intervalMs = options.intervalMs || 3600000;

    // Parse model if provided
    let model: LLMModel;
    if (options.model) {
      const parts = options.model.split('/');
      const provider = parts[0];
      const modelId = parts[1] || 'qwen2.5:0.5b';

      // Map provider names to LLMProvider type
      let llmProvider: LLMProvider;
      let providerId: CloudProviderId | '' = '';
      if (provider === 'anthropic') {
        llmProvider = 'cloud';
        providerId = 'anthropic';
      } else if (provider === 'kimi') {
        llmProvider = 'cloud';
        providerId = 'moonshot';
      } else {
        llmProvider = 'ollama';
      }

      if (llmProvider === 'cloud') {
        const apiKey = process.env.SYN_LLMAPI_KEY;
        if (!apiKey) {
          logger.error(`❌ Error: SYN_LLMAPI_KEY required for ${provider} models`);
          logger.log(`   export SYN_LLMAPI_KEY=your-key-here`);
          process.exit(1);
        }
      }

      logger.log(`🤖 Using model: ${options.model}`);
      model = { provider: llmProvider, providerId, modelId };
    } else {
      logger.log('🤖 No model specified. Using default: ollama/qwen2.5:0.5b');
      model = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };
    }
    logger.log('');

    // Check identity
    const identityPath = path.join(os.homedir(), '.synapseia');
    if (!fs.existsSync(path.join(identityPath, 'identity.json'))) {
      logger.log('🔑 No identity found. Generating Keypair...');
      generateIdentity(identityPath);
      logger.log(`✅ Saved to: ${path.join(identityPath, 'identity.json')}`);
    } else {
      logger.log(`✅ Identity loaded from: ${identityPath}`);
    }

    const identity = loadIdentity(identityPath);
    logger.log(`   Peer ID: ${identity.peerId.slice(0, 16)}...`);
    logger.log('');

    // Check hardware
    logger.log('🔍 Detecting hardware...');
    const hardware = detectHardware(options.cpu);
    logger.log(`   CPU: ${hardware.cpuCores} cores`);
    logger.log(`   RAM: ${hardware.ramGb} GB`);
    logger.log(`   GPU: ${hardware.gpuVramGb > 0 ? hardware.gpuVramGb + 'GB VRAM' : 'None'}`);
    logger.log(`   Tier: ${hardware.tier} (${getTierName(hardware.tier as HardwareTier)})`);
    const capabilities: string[] = [];
    if (!options.cpu) capabilities.push('gpu');
    if (hardware.hasOllama) capabilities.push('ollama');
    logger.log(`   Capabilities: ${capabilities.join(', ') || 'cpu'}`);
    logger.log('');

    // Check dataset
    if (!fs.existsSync(datasetPath)) {
      logger.warn(`⚠️  Dataset not found: ${datasetPath}`);
      logger.log(`   Using embedded sample data...`);
    } else {
      const stats = fs.statSync(datasetPath);
      logger.log(`📊 Dataset: ${datasetPath} (${(stats.size / 1024).toFixed(1)}KB)`);
    }
    logger.log('');

    // Start P2P node
    logger.log('🌐 Starting P2P node...');
    let p2pNode;
    try {
      // Build bootstrap multiaddr for the coordinator's P2P port (9000)
      // Use /ip4/127.0.0.1 for localhost to avoid DNS resolution issues with libp2p
      const rawHost = coordinatorUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
      const isLocalhost = rawHost === 'localhost' || rawHost === '127.0.0.1';
      const bootstrapAddrs = rawHost
        ? [isLocalhost
            ? `/ip4/127.0.0.1/tcp/9000`
            : `/dns4/${rawHost}/tcp/9000`]
        : [];
      p2pNode = await createP2PNode(identity, bootstrapAddrs);
      logger.log(`   P2P peerId: ${p2pNode.getPeerId()}`);
    } catch (err) {
      logger.warn('   P2P init failed, using HTTP fallback:', (err as Error).message);
    }

    // Start heartbeat
    logger.log('💓 Starting heartbeat loop...');
    const heartbeatCleanup = startPeriodicHeartbeat(
      coordinatorUrl,
      identity,
      hardware,
      intervalMs,
      p2pNode,
    );
    logger.log(`   Coordinator: ${coordinatorUrl}`);
    logger.log(`   Interval: ${(intervalMs / 1000).toFixed(0)}s`);
    logger.log('');

    // Start agent research loop
    logger.log('🔄 Starting agent research loop...');
    const config: AgentLoopConfig = {
      coordinatorUrl: coordinatorUrl,
      peerId: identity.peerId,
      capabilities,
      intervalMs: interval,
      datasetPath: datasetPath,
      maxIterations: maxIterations,
    };
    logger.log(`   Experiment interval: ${(interval / 1000).toFixed(0)}s`);
    if (maxIterations > 0) {
      logger.log(`   Max iterations: ${maxIterations}`);
    }
    logger.log('   Model:', options.model || 'ollama/qwen2.5:0.5b');
    logger.log('');
    logger.log('🚀 Synapse Node running. Press Ctrl+C to stop.\n');

    new AgentLoopHelper().startAgentLoop(config);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.log('\n\n🛑 Shutting down...');
      heartbeatCleanup();
      logger.log('✅ Goodbye!');
      process.exit(0);
    });
  });

program
  .command('status')
  .description('Show node status')
  .action(() => {
    logger.log('📊 Synapse Node Status\n');
    const identityPath = path.join(os.homedir(), '.synapseia');
    if (fs.existsSync(path.join(identityPath, 'identity.json'))) {
      const identity = loadIdentity(identityPath);
      logger.log(`   Peer ID: ${identity.peerId}`);
      logger.log(`   Public Key: ${identity.publicKey.slice(0, 64)}...`);
    } else {
      logger.log('   Status: Node not configured (run `synapse start` first)');
      return;
    }

    const hardware = detectHardware(false);
    logger.log(`   Hardware: ${hardware.tier} (${hardware.cpuCores} cores, ${hardware.ramGb}GB RAM)`);
    logger.log(`   GPU: ${hardware.gpuVramGb > 0 ? hardware.gpuVramGb + 'GB' : 'None'}`);
    logger.log(`   Ollama: ${hardware.hasOllama ? '✅ Installed' : '❌ Not found'}`);

    const capabilities: string[] = [];
    if (!hardware.gpuVramGb) capabilities.push('cpu');
    if (hardware.hasOllama) capabilities.push('ollama');
    logger.log(`   Capabilities: ${capabilities.join(', ')}`);

    logger.log(`   Uptime: ${process.uptime().toFixed(0)}s`);
    logger.log(`   Platform: ${os.platform()} ${os.arch()}`);
  });

program
  .command('models')
  .description('Manage local models (Ollama)')
  .action(async () => {
    logger.log('📦 Synapse Models\n');

    const hardware = detectHardware(false);
    
    if (!hardware.hasOllama) {
      logger.log('❌ Ollama not found at localhost:11434');
      logger.log('   Install: https://ollama.com/download');
      return;
    }

    logger.log('   Checking available models...\n');
    // TODO: fetch ollama API
    logger.log('   <model list from Ollama API>');
    logger.log('');

    logger.log(`Recommended for Tier ${hardware.tier}:`);
    if (hardware.tier >= 5) {
      logger.log('   • Llama-3.3-70B (requires >48GB VRAM)');
      logger.log('   • Mixtral 8x7B (requires >32GB VRAM)');
    } else if (hardware.tier >= 4) {
      logger.log('   • Llama-3.3-70B (requires 48GB VRAM)');
      logger.log('   • Mixtral 8x7B (requires 24GB VRAM)');
    } else if (hardware.tier >= 3) {
      logger.log('   • Gemma-3-1B (4GB VRAM)');
      logger.log('   • Phi-3-mini (2.5GB VRAM)');
    } else if (hardware.tier >= 2) {
      logger.log('   • Qwen2.5-1.5B (3GB VRAM)');
      logger.log('   • Llama-3-8B (16GB VRAM)');
    } else {
      logger.log('   • Gemma-3-1B (4GB VRAM)');
      logger.log('   • Phi-3-mini (2.5GB VRAM)');
    }
    logger.log('');
    logger.log('Pull with: ollama pull <model-name>');
  });

program
  .command('hive')
  .description('Hive operations')
  .command('whoami')
  .description('Show agent identity information')
  .action(() => {
    const identityPath = path.join(os.homedir(), '.synapseia');
    if (!fs.existsSync(path.join(identityPath, 'identity.json'))) {
      logger.log('❌ No identity found. Run `synapse start` first.');
      return;
    }

    const identity = loadIdentity(identityPath);
    const profile = getAgentProfile(identity);

    logger.log('🐝 Hive Agent Identity\n');
    logger.log(`   Agent ID: ${profile.agentId}`);
    logger.log(`   Peer ID:  ${profile.peerId}`);
    logger.log(`   Tier:     ${profile.tier} (${getTierName(profile.tier as any)})`);
    logger.log(`   Mode:     ${profile.mode.toUpperCase()}`);
    logger.log(`   Status:   ${profile.status.toUpperCase()}`);
    logger.log(`   Created:  ${new Date(profile.createdAt).toISOString()}`);
  });

program.parse();
