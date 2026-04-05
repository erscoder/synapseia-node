/**
 * A2A Server Service Tests
 * Sprint D — A2A Server
 */

import { A2AServer } from '../a2a-server.service';
import { AgentCardService } from '../agent-card.service';
import { A2AAuthService } from '../auth/a2a-auth.service';
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
    tier: 1,
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
  let taskRouter: TaskRouter;
  let port: number;

  beforeEach(() => {
    agentCardService = makeAgentCardService();
    authService = new A2AAuthService();
    taskRouter = makeTaskRouter(agentCardService);
    server = new A2AServer(agentCardService, authService, taskRouter);
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
  });
});
