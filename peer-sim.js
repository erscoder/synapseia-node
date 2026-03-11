#!/usr/bin/env node
/**
 * peer-sim.js — Simulated peer node for local dev
 * Sends heartbeat to coordinator every 30s
 */

const http = require('http');
const crypto = require('crypto');

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:3001';
const TIER = parseInt(process.env.PEER_TIER || '1', 10);
const PEER_ID = process.env.PEER_ID || `sim-${crypto.randomBytes(8).toString('hex')}`;
const INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);

const CAPABILITIES_BY_TIER = {
  0: ['cpu'],
  1: ['cpu', 'embedding'],
  2: ['cpu', 'embedding', 'inference'],
  3: ['cpu', 'embedding', 'inference', 'storage'],
  4: ['cpu', 'embedding', 'inference', 'storage', 'orchestration'],
  5: ['cpu', 'embedding', 'inference', 'storage', 'orchestration', 'validation'],
};

const capabilities = CAPABILITIES_BY_TIER[TIER] || ['cpu'];
const startTime = Date.now();

function sendHeartbeat() {
  const payload = JSON.stringify({
    peerId: PEER_ID,
    walletAddress: null,
    tier: TIER,
    capabilities,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });

  const url = new URL('/peer/heartbeat', COORDINATOR_URL);
  const options = {
    hostname: url.hostname,
    port: url.port || 3001,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log(`[${new Date().toISOString()}] ✅ Heartbeat OK | peer=${PEER_ID} tier=${TIER} caps=${capabilities.join(',')}`);
    });
  });

  req.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ❌ Heartbeat failed: ${err.message} — retrying in ${INTERVAL_MS / 1000}s`);
  });

  req.write(payload);
  req.end();
}

console.log(`🔗 Peer sim starting — id=${PEER_ID} tier=${TIER} coordinator=${COORDINATOR_URL}`);
sendHeartbeat();
setInterval(sendHeartbeat, INTERVAL_MS);
