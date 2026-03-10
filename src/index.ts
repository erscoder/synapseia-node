#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const program = new Command();

program
  .name('synapse')
  .description('Synapse Node CLI — Join the decentralized compute network')
  .version('0.0.1');

program
  .command('start')
  .description('Start Synapse node')
  .option('--inference', 'Enable inference capability (requires GPU)')
  .option('--embedding', 'Enable embedding generation (CPU-only)')
  .option('--cpu', 'CPU-only mode (no GPU)')
  .action(async (options) => {
    console.log('🧠 Synapse Node CLI v0.0.1');
    console.log('Initializing node...');

    // Check identity
    const identityPath = path.join(os.homedir(), '.synapse', 'identity.json');
    if (!fs.existsSync(identityPath)) {
      console.log('No identity found. Generating Keypair...');
      // TODO: Generate Ed25519 keypair with @noble/ed25519
      console.log('✅ Identity created:', identityPath);
    } else {
      console.log('✅ Identity loaded:', identityPath);
    }

    // Check hardware
    if (options.cpu) {
      console.log('⚙️  Mode: CPU-only');
      // TODO: Detect Ollama at localhost:11434
    } else {
      console.log('⚙️  Mode: Inference enabled');
      // TODO: Detect GPU (nvidia-smi or apple_gpu)
    }

    console.log('Starting heartbeat...');
    // TODO: Heartbeat to coordinator (Fase 1)
  });

program
  .command('status')
  .description('Show node status')
  .action(() => {
    console.log('📊 Synapse Node Status');
    console.log('Peer ID: 12D3KooW...');
    console.log('Pubkey: 7xYz...');
    console.log('Tier: 1 (Apple M1 Pro, 16GB VRAM)');
    console.log('Capabilities: inference, embedding, storage, memory');
    console.log('Uptime: 7d 3h 45m');
    console.log('Points: 0.00 $SYN');
  });

program
  .command('models')
  .description('Manage models')
  .action(async () => {
    console.log('📦 Syncing models...');

    // Try to connect to Ollama
    console.log('Checking Ollama at localhost:11434...');
    // TODO: fetch http://localhost:11434/models

    console.log('Recommended for your tier (Tier 1):');
    console.log('  Gemma-3-1B (4GB)');
    console.log('');
    console.log('Run: synapse models pull --auto');
  });

program.parse();
