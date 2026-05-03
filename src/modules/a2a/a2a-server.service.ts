/**
 * A2A Server Service
 * Sprint D — A2A Server for Synapseia Node
 *
 * HTTP server that implements the A2A protocol:
 * - GET  /.well-known/agent.json  → AgentCard
 * - POST /tasks/send               → Execute delegated task
 *
 * Uses Node's built-in http module for raw request handling.
 */

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { A2ARequest, A2ATask, A2ATaskResult } from './types';
import { AgentCardService } from './agent-card.service';
import { A2AAuthService } from './auth/a2a-auth.service';
import { TaskRouter } from './task-router';
import type { Identity } from '../identity/identity';
import logger from '../../utils/logger';

@Injectable()
export class A2AServer implements OnModuleDestroy {
  private server: http.Server | null = null;
  private running = false;

  constructor(
    private readonly agentCardService: AgentCardService,
    private readonly authService: A2AAuthService,
    private readonly taskRouter: TaskRouter,
  ) {}

  /**
   * Start the A2A HTTP server on the given port.
   */
  async start(port: number): Promise<void> {
    if (this.running) {
      throw new Error('A2A server already running');
    }

    this.server = http.createServer(this.handleRequest.bind(this));

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);

      this.server!.listen(port, () => {
        this.running = true;
        const addr = this.server!.address() as AddressInfo;
        logger.log(`[A2A] Server listening on port ${addr.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the A2A HTTP server gracefully.
   */
  async stop(): Promise<void> {
    if (!this.server || !this.running) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.running = false;
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Returns true if the server is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the port the server is listening on.
   */
  getPort(): number | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return addr.port;
  }

  /**
   * Handle an incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // S0.5: replace `Allow-Origin: *` with a strict local-only
    // allowlist (audit P0 #5). DNS rebinding from a malicious site can
    // no longer pivot to this server because foreign origins get no
    // CORS headers and any preflight is rejected with 403.
    const { applyLocalCors } = await import('../../shared/local-cors');
    if (applyLocalCors(req, res)) return;

    const url = req.url ?? '/';

    try {
      // GET /.well-known/agent.json
      if (req.method === 'GET' && url === '/.well-known/agent.json') {
        return this.handleAgentCard(req, res);
      }

      // GET /health
      if (req.method === 'GET' && url === '/health') {
        return this.handleHealth(req, res);
      }

      // POST /tasks/send
      if (req.method === 'POST' && url === '/tasks/send') {
        return this.handleTaskSend(req, res);
      }

      // 404 everything else
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found', path: url }));
    } catch (err) {
      logger.error(`[A2A] Request error: ${(err as Error).message || String(err)}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }

  /**
   * Handle GET /.well-known/agent.json
   */
  private handleAgentCard(_req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const card = this.agentCardService.getCard();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(card));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handle GET /health
   */
  private handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', a2a: this.running }));
  }

  /**
   * Handle POST /tasks/send
   */
  private async handleTaskSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Read body
    const body = await this.readBody(req);

    let parsed: A2ARequest;
    try {
      parsed = JSON.parse(body) as A2ARequest;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { task } = parsed;
    if (!task || !task.id || !task.type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing task fields: id, type required' }));
      return;
    }

    // Verify sender public key is provided in headers
    const senderPublicKey = (req.headers['x-public-key'] as string) ?? '';

    // Reject unauthenticated requests — X-Public-Key header is mandatory
    if (!senderPublicKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing X-Public-Key header — authentication required' }));
      return;
    }

    // Verify signature
    const valid = await this.authService.verify(task, senderPublicKey);
    if (!valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature or expired request' }));
      return;
    }

    // Route task
    const result = await this.taskRouter.route(task);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /**
   * Read and parse the request body as a string.
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Clean up on module destroy.
   */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}
