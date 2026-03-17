#!/usr/bin/env node
/**
 * peer-sim.cjs — Simulated peer node for local dev
 * Features:
 * - Heartbeat to coordinator
 * - Poll for available work orders
 * - Accept and execute work orders with LLM inference
 * - Complete work orders and report results
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Wallet storage path
const DATA_DIR = process.env.PEER_DATA_DIR || './peer-data';
const WALLET_FILE = path.join(DATA_DIR, 'wallet.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Base58 encoding table (same as Solana)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toBase58(buffer) {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    result += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

// Load or create Solana-compatible Ed25519 keypair (using Node.js crypto)
async function loadOrCreateWallet(peerId) {
  // Try to load existing wallet
  if (fs.existsSync(WALLET_FILE)) {
    try {
      const walletData = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
      if (walletData.peerId === peerId && walletData.secretKey) {
        return walletData;
      }
    } catch (err) {
      console.warn('[Wallet] Failed to load existing wallet, creating new one:', err.message);
    }
  }

  // Create new deterministic wallet from peerId (32-byte seed -> Ed25519 keypair)
  const seed = crypto.createHash('sha256').update(peerId).digest();
  const { publicKey, secretKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const walletData = {
    peerId,
    publicKey: toBase58(Buffer.from(seed.slice(0, 32))),
    secretKey: Array.from(seed),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2));

  return walletData;
}

// Configuration
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:3001';
const TIER = parseInt(process.env.PEER_TIER || '1', 10);
const PEER_ID = process.env.PEER_ID || `sim-${crypto.randomBytes(8).toString('hex')}`;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);
const WORK_ORDER_INTERVAL_MS = parseInt(process.env.WORK_ORDER_INTERVAL || '30000', 10);

// Network configuration
const LLM_URL = process.env.LLM_CLOUD_BASE_URL || process.env.LLM_URL || 'http://localhost:11434/api/chat';
const LLM_MODEL = process.env.LLM_CLOUD_MODEL || process.env.LLM_MODEL || 'mistral:7b-instruct-v0.2-q4_K_M';

// Capabilities based on tier
const TIER_CAPABILITIES = {
  0: ['cpu'],
  1: ['cpu', 'embedding'],
  2: ['cpu', 'embedding', 'inference']
};

const capabilities = TIER_CAPABILITIES[TIER] || ['cpu'];

// Work order status
const WORK_ORDER_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
};

// HTTP client with certificate verification disabled for dev
async function httpAgent(url, options = {}) {
  const urlObj = new URL(url);
  const agent = urlObj.protocol === 'https:' ? new https.Agent({ rejectUnauthorized: false }) : null;

  const response = await new Promise((resolve, reject) => {
    const req = (urlObj.protocol === 'https:' ? https : http).request(url, {
      ...options,
      agent,
      rejectUnauthorized: false
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });

  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${response.statusText || response.data?.message || 'Unknown error'}`);
  }

  return response.data;
}

function validateHttpAgentResponse(data, statusCode) {
  if (!data) {
    throw new Error('No data received');
  }
  if (statusCode >= 400) {
    const message = data?.message || data?.error || 'Unknown error';
    throw new Error(`HTTP ${statusCode}: ${message}`);
  }
}

async function verifyCoordinator() {
  try {
    const res = await httpAgent(`${COORDINATOR_URL}/health`);
    if (res.status === 'ok') {
      console.log(`✅ Coordinator healthy`);
      return true;
    }
  } catch (err) {
    console.error(`❌ Health check failed: ${err.message}`);
    return false;
  }
}

async function fetchWorkOrders(walletData) {
  try {
    return await httpAgent(`${COORDINATOR_URL}/work-orders/available?peerId=${encodeURIComponent(PEER_ID)}&capabilities=${encodeURIComponent(capabilities.join(','))}`);
  } catch (err) {
    console.warn(`[WorkOrderAgent] Failed to fetch work orders: ${err.message}`);
    return [];
  }
}

async function acceptWorkOrder(workOrderId, walletData) {
  try {
    await httpAgent(`${COORDINATOR_URL}/work-orders/${encodeURIComponent(workOrderId)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        workOrderId,
        assigneeAddress: walletData.publicKey,
        nodeCapabilities: capabilities
      }
    });

    console.log(`[WorkOrderAgent] ✅ Accepted work order ${workOrderId}`);
    return true;
  } catch (err) {
    console.warn(`[WorkOrderAgent] Failed to accept work order ${workOrderId}: ${err.message}`);
    return false;
  }
}

async function executeWorkOrder(workOrderId, workOrder, walletData) {
  try {
    console.log(`[WorkOrderAgent] 🚀 Executing: "${workOrder.title}"`);

    const chatUrl = LLM_URL.endsWith('/v1') || LLM_URL.endsWith('/v1/') ?
      `${LLM_URL.replace(/\/+$/, '')}/chat/completions` :
      `${LLM_URL.replace(/\/chat$/, '')}/chat`;

    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: 'You are a helpful research agent. Provide concise, accurate information.' },
          { role: 'user', content: workOrder.description || workOrder.title }
        ],
        stream: false,
        temperature: 0.7,
        max_tokens: 512
      })
    });

    if (!res.ok) {
      throw new Error(`LLM request failed: ${res.status}`);
    }

    const data = await res.json();
    const response = data?.choices?.[0]?.message?.content || data?.message?.content || 'No response';

    console.log(`[WorkOrderAgent] 📝 Response: ${response.substring(0, 100)}...`);
    console.log(`[WorkOrderAgent] 📜 Model: ${data?.model || LLM_MODEL}`);

    return {
      success: true,
      response,
      model: data?.model || LLM_MODEL,
      inferenceTime: data?.usage?.total_tokens || 0
    };
  } catch (err) {
    console.error(`[WorkOrderAgent] ❌ Execution failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function completeWorkOrder(workOrderId, result, walletData) {
  try {
    await httpAgent(`${COORDINATOR_URL}/work-orders/${encodeURIComponent(workOrderId)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        workOrderId,
        assigneeAddress: walletData.publicKey,
        result: result.response || result.error,
        status: result.success ? WORK_ORDER_STATUS.COMPLETED : WORK_ORDER_STATUS.FAILED
      }
    });

    console.log(`[WorkOrderAgent] ✅ Completed ${workOrderId}`);
  } catch (err) {
    console.warn(`[WorkOrderAgent] Failed to complete: ${err.message}`);
  }
}

async function workOrderAgent(walletData) {
  try {
    const workOrders = await fetchWorkOrders();

    if (!Array.isArray(workOrders) || workOrders.length === 0) {
      console.log('[WorkOrderAgent] No work orders available');
      return;
    }

    console.log(`[WorkOrderAgent] Found ${workOrders.length} available work order(s)`);

    for (const workOrder of workOrders) {
      try {
        if (workOrder.status !== WORK_ORDER_STATUS.PENDING) {
          continue;
        }

        const accepted = await acceptWorkOrder(workOrder.id, walletData);
        if (!accepted) continue;

        const result = await executeWorkOrder(workOrder.id, workOrder, walletData);
        await completeWorkOrder(workOrder.id, result, walletData);
      } catch (err) {
        console.error(`[WorkOrderAgent] Error processing ${workOrder.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[WorkOrderAgent] Iteration error: ${err.message}`);
  }
}

async function main() {
  console.log(`🔗 Peer sim starting`);
  console.log(`   id=${PEER_ID}`);
  console.log(`   coordinator=${COORDINATOR_URL}`);

  const walletData = await loadOrCreateWallet(PEER_ID);
  console.log(`   wallet=${walletData.publicKey} (deterministic from peerId)`);

  console.log(`   llm=@${LLM_URL}`);
  console.log(`   caps=${capabilities.join(',')}`);
  console.log();

  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    if (await verifyCoordinator()) {
      break;
    }
    attempts++;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (attempts >= maxAttempts) {
    console.error('❌ Failed to connect to coordinator after multiple attempts');
    process.exit(1);
  }

  setInterval(() => workOrderAgent(walletData), WORK_ORDER_INTERVAL_MS);

  workOrderAgent(walletData);
}

main().catch(err => {
  console.error('Failed to start peer sim:', err);
  process.exit(1);
});
