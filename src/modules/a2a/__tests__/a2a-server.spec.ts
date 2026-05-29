/**
 * A2A Server Service Tests
 * Sprint D — A2A Server
 */

import { A2AServer } from '../a2a-server.service';
import { AgentCardService } from '../agent-card.service';
import { A2AAuthService } from '../auth/a2a-auth.service';
import { A2AAuthorizationService } from '../auth/a2a-authorization.service';
import { PeerRegistryService } from '../client/peer-registry.service';
import { TaskRouter } from '../task-router';
import { PeerReviewHandler } from '../handlers/peer-review.handler';
import { EmbeddingHandler } from '../handlers/embedding.handler';
import { HealthCheckHandler } from '../handlers/health-check.handler';
import { DelegateResearchHandler } from '../handlers/delegate-research.handler';
import { KnowledgeQueryHandler } from '../handlers/knowledge-query.handler';

jest.mock('../auth/a2a-auth.service', () => ({
  A2AAuthService: jest.fn().mockImplementation(() => ({
    verify: (jest.fn() as any).mockReturnValue(true),
    sign: (jest.fn() as any).mockReturnValue('mock-signature'),
    verifyEd25519: (jest.fn() as any).mockReturnValue(true),
  })),
}));

function makeAgentCardService(): AgentCardService {
  const service = new AgentCardService();
  service.configure({
    peerId: 'test-peer-id-12345678',
    hardwareClass: 1,
    domain: 'test',
    capabilities: ['llm', 'embedding'],
    a2aPort: 0, // 0 = auto-assign in tests
  });
  return service;
}

function makeTaskRouter(agentCardService: AgentCardService): TaskRouter {
  const peerReviewHandler = new PeerReviewHandler();
  const embeddingHandler = new EmbeddingHandler();
  const healthCheckHandler = new HealthCheckHandler(agentCardService);
  const delegateResearchHandler = new DelegateResearchHandler();
  const knowledgeQueryHandler = { handle: jest.fn() } as unknown as KnowledgeQueryHandler;

  return new TaskRouter(
    peerReviewHandler,
    embeddingHandler,
    healthCheckHandler,
    delegateResearchHandler,
    knowledgeQueryHandler,
  );
}

describe('A2AServer', () => {
  let server: A2AServer;
  let agentCardService: AgentCardService;
  let authService: A2AAuthService;
  let authzService: A2AAuthorizationService;
  let peerRegistry: PeerRegistryService;
  let taskRouter: TaskRouter;
  let port: number;

  beforeEach(() => {
    agentCardService = makeAgentCardService();
    authService = new A2AAuthService();
    peerRegistry = new PeerRegistryService();
    authzService = new A2AAuthorizationService(peerRegistry);
    taskRouter = makeTaskRouter(agentCardService);
    server = new A2AServer(agentCardService, authService, authzService, taskRouter);
    port = 18080 + Math.floor(Math.random() * 1000);
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('start / stop', () => {
    it('should start and stop the server', async () => {
      expect(server.isRunning()).toBe(false);

      await server.start(port);

      expect(server.isRunning()).toBe(true);
      expect(server.getPort()).toBe(port);

      await server.stop();
      expect(server.isRunning()).toBe(false);
    });

    it('should reject start if already running', async () => {
      await server.start(port);
      await expect(server.start(port)).rejects.toThrow('already running');
    });

    it('should report correct port after start', async () => {
      await server.start(port);
      expect(server.getPort()).toBe(port);
    });
  });

  describe('HTTP endpoints', () => {
    beforeEach(async () => {
      await server.start(port);
    });

    afterEach(async () => {
      await server.stop();
    });

    function fetch(path: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
      return new Promise((resolve) => {
        const http = require('node:http');
        const req = http.request(
          {
            hostname: 'localhost',
            port,
            path,
            method: options?.method ?? 'GET',
            headers: (options?.headers as Record<string, string>) ?? {},
          },
          (res: { statusCode: number; on: Function }) => {
            let data = '';
            res.on('data', (chunk: string) => (data += chunk));
            res.on('end', () => {
              let body: unknown = data;
              try {
                body = JSON.parse(data);
              } catch {}
              resolve({ status: res.statusCode, body });
            });
          },
        );
        if (options?.body) req.write(options.body);
        req.end();
      });
    }

    it('GET /.well-known/agent.json should return AgentCard', async () => {
      const { status, body } = await fetch('/.well-known/agent.json');

      expect(status).toBe(200);
      const card = body as Record<string, unknown>;
      expect(card['name']).toContain('Synapseia Node');
      expect(card['skills']).toBeInstanceOf(Array);
      expect(card['authentication']).toBeDefined();
    });

    it('GET /health should return ok status', async () => {
      const { status, body } = await fetch('/health');

      expect(status).toBe(200);
      const health = body as Record<string, unknown>;
      expect(health['status']).toBe('ok');
      expect(health['a2a']).toBe(true);
    });

    it('POST /tasks/send with valid task should execute and return result', async () => {
      const taskPayload = {
        task: {
          id: 'test-task-1',
          type: 'health_check',
          payload: {},
          senderPeerId: 'sender-peer',
          timestamp: Date.now(),
          nonce: Math.random().toString(36).slice(2),
          signature: 'a'.repeat(128),
        },
        headers: {},
      };

      const { status, body } = await fetch('/tasks/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-public-key': 'test-public-key' },
        body: JSON.stringify(taskPayload),
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      expect(result['success']).toBe(true);
      expect(result['taskId']).toBe('test-task-1');
      expect(result['data']).toHaveProperty('status', 'ok');
    });

    it('POST /tasks/send with invalid JSON should return 400', async () => {
      const { status } = await fetch('/tasks/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      expect(status).toBe(400);
    });

    it('POST /tasks/send with missing task fields should return 400', async () => {
      const { status, body } = await fetch('/tasks/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: {} }),
      });

      expect(status).toBe(400);
      const result = body as Record<string, unknown>;
      expect(result['error']).toContain('Missing task fields');
    });

    it('unknown path should return 404', async () => {
      const { status } = await fetch('/unknown/path');

      expect(status).toBe(404);
    });

    it('OPTIONS request should return 204', async () => {
      const { status } = await fetch('/', { method: 'OPTIONS' });

      expect(status).toBe(204);
    });

    it('POST /tasks/send with oversized body should return 413', async () => {
      // ~300 KiB payload, above the 256 KiB cap.
      const big = 'x'.repeat(300 * 1024);
      const { status } = await fetch('/tasks/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-public-key': 'k' },
        body: JSON.stringify({ task: { id: 't', type: 'health_check', payload: { big } } }),
      });
      expect(status).toBe(413);
    });
  });
});

/**
 * End-to-end security tests with the REAL A2AAuthService + A2AAuthorizationService
 * (no mock) so the assertions are behavioral, not mock-only. Covers FINDING 1
 * (identity binding + authorization allowlist) and FINDING 2 (payload binding).
 */
describe('A2AServer — security (real auth/authz)', () => {
  // Use the real implementations, bypassing the file-level jest.mock above.
  const RealAuth = jest.requireActual('../auth/a2a-auth.service')
    .A2AAuthService as typeof A2AAuthService;
  const crypto = require('node:crypto');

  function genKeypair(): { privateKeyHex: string; publicKeyHex: string; peerId: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privHex = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).slice(-32).toString('hex');
    const pubHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).slice(-32).toString('hex');
    return { privateKeyHex: privHex, publicKeyHex: pubHex, peerId: pubHex.slice(0, 32) };
  }

  let server: A2AServer;
  let auth: A2AAuthService;
  let peerRegistry: PeerRegistryService;
  let authz: A2AAuthorizationService;
  let port: number;

  function signTask(
    task: { id: string; type: string; payload: Record<string, unknown>; senderPeerId: string; timestamp: number; nonce: string },
    privateKeyHex: string,
  ): Record<string, unknown> {
    const message = (auth as any).buildMessage(task);
    const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
    const derKey = Buffer.concat([PKCS8_HEADER, Buffer.from(privateKeyHex, 'hex')]);
    const keyObject = crypto.createPrivateKey({ key: derKey, format: 'der', type: 'pkcs8' });
    const signature = crypto.sign(null, Buffer.from(message, 'utf-8'), keyObject).toString('hex');
    return { ...task, signature };
  }

  function post(path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve) => {
      const http = require('node:http');
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method: 'POST', headers },
        (res: { statusCode: number; on: Function }) => {
          let data = '';
          res.on('data', (c: string) => (data += c));
          res.on('end', () => {
            let parsed: unknown = data;
            try { parsed = JSON.parse(data); } catch {}
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.write(body);
      req.end();
    });
  }

  beforeEach(async () => {
    const agentCardService = makeAgentCardService();
    auth = new RealAuth();
    peerRegistry = new PeerRegistryService();
    authz = new A2AAuthorizationService(peerRegistry);
    const taskRouter = makeTaskRouter(agentCardService);
    server = new A2AServer(agentCardService, auth, authz, taskRouter);
    port = 19080 + Math.floor(Math.random() * 800);
    await server.start(port, '127.0.0.1');
  });

  afterEach(async () => {
    auth.clearNonces();
    await server.stop();
  });

  // (a) X-Public-Key not matching senderPeerId → REJECTED (401).
  it('rejects a task whose X-Public-Key does not match senderPeerId', async () => {
    const attacker = genKeypair();
    const victimPeerId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const task = signTask(
      { id: 't1', type: 'health_check', payload: {}, senderPeerId: victimPeerId, timestamp: Date.now(), nonce: 'n1' },
      attacker.privateKeyHex,
    );
    const { status } = await post(
      '/tasks/send',
      { 'Content-Type': 'application/json', 'x-public-key': attacker.publicKeyHex },
      JSON.stringify({ task }),
    );
    expect(status).toBe(401);
  });

  // (b) Unauthorized peer/task-type → REJECTED (403). A bound, validly-signed
  // peer that is NOT in the registry and NOT the coordinator may not run a
  // privileged task type (delegate_research).
  it('rejects an unauthorized peer for a privileged task type', async () => {
    const k = genKeypair();
    const task = signTask(
      { id: 't2', type: 'delegate_research', payload: { workOrder: 'x' }, senderPeerId: k.peerId, timestamp: Date.now(), nonce: 'n2' },
      k.privateKeyHex,
    );
    const { status, body } = await post(
      '/tasks/send',
      { 'Content-Type': 'application/json', 'x-public-key': k.publicKeyHex },
      JSON.stringify({ task }),
    );
    expect(status).toBe(403);
    expect((body as Record<string, unknown>)['error']).toContain('not authorized');
  });

  // (c) Payload tampered after signing → REJECTED (401).
  it('rejects a payload-tampered but otherwise-valid signed task', async () => {
    const k = genKeypair();
    const signed = signTask(
      { id: 't3', type: 'health_check', payload: { ok: true }, senderPeerId: k.peerId, timestamp: Date.now(), nonce: 'n3' },
      k.privateKeyHex,
    );
    (signed as Record<string, unknown>)['payload'] = { ok: false, injected: 'evil' };
    const { status } = await post(
      '/tasks/send',
      { 'Content-Type': 'application/json', 'x-public-key': k.publicKeyHex },
      JSON.stringify({ task: signed }),
    );
    expect(status).toBe(401);
  });

  // (d) Correctly-signed + authorized task → ACCEPTED (200). A known live peer
  // running an allowed task type. health_check is publicly reachable for any
  // authenticated caller.
  it('accepts a correctly-signed, identity-bound, authorized task', async () => {
    const k = genKeypair();
    const task = signTask(
      { id: 't4', type: 'health_check', payload: {}, senderPeerId: k.peerId, timestamp: Date.now(), nonce: 'n4' },
      k.privateKeyHex,
    );
    const { status, body } = await post(
      '/tasks/send',
      { 'Content-Type': 'application/json', 'x-public-key': k.publicKeyHex },
      JSON.stringify({ task }),
    );
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['success']).toBe(true);
  });

  // (d') A registered (known) peer is authorized for a privileged task type.
  it('accepts a privileged task from a registered live peer', async () => {
    const k = genKeypair();
    peerRegistry.updatePeer({
      peerId: k.peerId,
      a2aUrl: 'http://127.0.0.1:1',
      capabilities: ['research'],
      hardwareClass: 1,
      domain: 'test',
      lastSeen: Date.now(),
    });
    const task = signTask(
      { id: 't5', type: 'delegate_research', payload: { workOrder: 'wo-1' }, senderPeerId: k.peerId, timestamp: Date.now(), nonce: 'n5' },
      k.privateKeyHex,
    );
    const { status } = await post(
      '/tasks/send',
      { 'Content-Type': 'application/json', 'x-public-key': k.publicKeyHex },
      JSON.stringify({ task }),
    );
    expect(status).toBe(200);
  });
});
