#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { generateIdentity, loadIdentity } from './identity.js';
import { detectHardware, getTierName } from './hardware.js';
import { startPeriodicHeartbeat } from './heartbeat.js';
import { startAgentLoop, type AgentLoopConfig } from './agent-loop.js';
import { generateLLM, type LLMModel, type LLMProvider } from './llm-provider.js';

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
    console.log('🧠 Synapse Node CLI v0.0.1');
    console.log('');

    // Set defaults
    const datasetPath = options.dataset || path.join(process.cwd(), 'data', 'astro-sample.txt');
    const coordinatorUrl = options.coordinator || 'http://localhost:3001';
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
      let providerId = '';
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
          console.error(`❌ Error: SYN_LLMAPI_KEY required for ${provider} models`);
          console.log(`   export SYN_LLMAPI_KEY=your-key-here`);
          process.exit(1);
        }
      }

      console.log(`🤖 Using model: ${options.model}`);
      model = { provider: llmProvider, providerId, modelId };
    } else {
      console.log('🤖 No model specified. Using default: ollama/qwen2.5:0.5b');
      model = { provider: 'ollama', providerId: '', modelId: 'qwen2.5:0.5b' };
    }
    console.log('');

    // Check identity
    const identityPath = path.join(os.homedir(), '.synapse');
    if (!fs.existsSync(path.join(identityPath, 'identity.json'))) {
      console.log('🔑 No identity found. Generating Keypair...');
      generateIdentity(identityPath);
      console.log(`✅ Saved to: ${path.join(identityPath, 'identity.json')}`);
    } else {
      console.log(`✅ Identity loaded from: ${identityPath}`);
    }

    const identity = loadIdentity(identityPath);
    console.log(`   Peer ID: ${identity.peerId.slice(0, 16)}...`);
    console.log('');

    // Check hardware
    console.log('🔍 Detecting hardware...');
    const hardware = detectHardware(options.cpu);
    console.log(`   CPU: ${hardware.cpuCores} cores`);
    console.log(`   RAM: ${hardware.ramGb} GB`);
    console.log(`   GPU: ${hardware.gpuVramGb > 0 ? hardware.gpuVramGb + 'GB VRAM' : 'None'}`);
    console.log(`   Tier: ${hardware.tier} (${getTierName(hardware.tier)})`);
    const capabilities: string[] = [];
    if (!options.cpu) capabilities.push('gpu');
    if (hardware.hasOllama) capabilities.push('ollama');
    console.log(`   Capabilities: ${capabilities.join(', ') || 'cpu'}`);
    console.log('');

    // Check dataset
    if (!fs.existsSync(datasetPath)) {
      console.warn(`⚠️  Dataset not found: ${datasetPath}`);
      console.log(`   Using embedded sample data...`);
    } else {
      const stats = fs.statSync(datasetPath);
      console.log(`📊 Dataset: ${datasetPath} (${(stats.size / 1024).toFixed(1)}KB)`);
    }
    console.log('');

    // Start heartbeat
    console.log('💓 Starting heartbeat loop...');
    const heartbeatCleanup = startPeriodicHeartbeat(
      coordinatorUrl,
      identity,
      hardware,
      intervalMs,
    );
    console.log(`   Coordinator: ${coordinatorUrl}`);
    console.log(`   Interval: ${(intervalMs / 1000).toFixed(0)}s`);
    console.log('');

    // Start agent research loop
    console.log('🔄 Starting agent research loop...');
    const config: AgentLoopConfig = {
      coordinatorUrl: coordinatorUrl,
      peerId: identity.peerId,
      capabilities,
      intervalMs: interval,
      datasetPath: datasetPath,
      maxIterations: maxIterations,
    };
    console.log(`   Experiment interval: ${(interval / 1000).toFixed(0)}s`);
    if (maxIterations > 0) {
      console.log(`   Max iterations: ${maxIterations}`);
    }
    console.log('   Model:', options.model || 'ollama/qwen2.5:0.5b');
    console.log('');
    console.log('🚀 Synapse Node running. Press Ctrl+C to stop.\n');

    startAgentLoop(config);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 Shutting down...');
      heartbeatCleanup();
      console.log('✅ Goodbye!');
      process.exit(0);
    });
  });

program
  .command('status')
  .description('Show node status')
  .action(() => {
    console.log('📊 Synapse Node Status\n');
    const identityPath = path.join(os.homedir(), '.synapse');
    if (fs.existsSync(path.join(identityPath, 'identity.json'))) {
      const identity = loadIdentity(identityPath);
      console.log(`   Peer ID: ${identity.peerId}`);
      console.log(`   Public Key: ${identity.publicKey.slice(0, 64)}...`);
    } else {
      console.log('   Status: Node not configured (run `synapse start` first)');
      return;
    }

    const hardware = detectHardware(false);
    console.log(`   Hardware: ${hardware.tier} (${hardware.cpuCores} cores, ${hardware.ramGb}GB RAM)`);
    console.log(`   GPU: ${hardware.gpuVramGb > 0 ? hardware.gpuVramGb + 'GB' : 'None'}`);
    console.log(`   Ollama: ${hardware.hasOllama ? '✅ Installed' : '❌ Not found'}`);

    const capabilities: string[] = [];
    if (!hardware.gpuVramGb) capabilities.push('cpu');
    if (hardware.hasOllama) capabilities.push('ollama');
    console.log(`   Capabilities: ${capabilities.join(', ')}`);

    console.log(`   Uptime: ${process.uptime().toFixed(0)}s`);
    console.log(`   Platform: ${os.platform()} ${os.arch()}`);
  });

program
  .command('models')
  .description('Manage local models (Ollama)')
  .action(async () => {
    console.log('📦 Synapse Models\n');

    const hardware = detectHardware(false);
    
    if (!hardware.hasOllama) {
      console.log('❌ Ollama not found at localhost:11434');
      console.log('   Install: https://ollama.com/download');
      return;
    }

    console.log('   Checking available models...\n');
    // TODO: fetch ollama API
    console.log('   <model list from Ollama API>');
    console.log('');

    console.log(`Recommended for Tier ${hardware.tier}:`);
    if (hardware.tier >= 5) {
      console.log('   • Llama-3.3-70B (requires >48GB VRAM)');
      console.log('   • Mixtral 8x7B (requires >32GB VRAM)');
    } else if (hardware.tier >= 4) {
      console.log('   • Llama-3.3-70B (requires 48GB VRAM)');
      console.log('   • Mixtral 8x7B (requires 24GB VRAM)');
    } else if (hardware.tier >= 3) {
      console.log('   • Gemma-3-1B (4GB VRAM)');
      console.log('   • Phi-3-mini (2.5GB VRAM)');
    } else if (hardware.tier >= 2) {
      console.log('   • Qwen2.5-1.5B (3GB VRAM)');
      console.log('   • Llama-3-8B (16GB VRAM)');
    } else {
      console.log('   • Gemma-3-1B (4GB VRAM)');
      console.log('   • Phi-3-mini (2.5GB VRAM)');
    }
    console.log('');
    console.log('Pull with: ollama pull <model-name>');
  });

program.parse();
