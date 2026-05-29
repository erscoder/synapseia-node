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
import { A2AAuthorizationService } from './auth/a2a-authorization.service';
import { TaskRouter } from './task-router';
import type { Identity } from '../identity/identity';
import logger from '../../utils/logger';

/**
 * Default bind address — loopback only (FINDING 1 / item 3). The A2A server
 * is reachable by *any* host on the network if it binds 0.0.0.0, and since
 * server-to-server callers skip CORS the only protection is the signature +
 * authorization layer. We fail safe by binding 127.0.0.1 unless the operator
 * explicitly opts into remote exposure with `A2A_BIND_ALL=true`.
 */
const LOOPBACK_HOST = '127.0.0.1';
const ALL_INTERFACES_HOST = '0.0.0.0';

/**
 * Hard cap on the POST body we will buffer BEFORE JSON parsing / auth. An
 * unauthenticated caller must not be able to exhaust memory by streaming a
 * huge body (the auth check happens only after the full body is read).
 */
const MAX_BODY_BYTES = 256 * 1024; // 256 KiB

@Injectable()
export class A2AServer implements OnModuleDestroy {
  private server: http.Server | null = null;
  private running = false;

  constructor(
    private readonly agentCardService: AgentCardService,
    private readonly authService: A2AAuthService,
    private readonly authzService: A2AAuthorizationService,
    private readonly taskRouter: TaskRouter,
  ) {}

  /**
   * Start the A2A HTTP server on the given port.
   *
   * Binds loopback (127.0.0.1) by default. Pass `host` explicitly to override,
   * or set `A2A_BIND_ALL=true` in the environment to bind all interfaces
   * (0.0.0.0) for remote server-to-server exposure. Remote callers do NOT go
   * through CORS, so the signature + authorization layer is the sole gate —
   * only open it when that is acceptable for the deployment.
   */
  async start(port: number, host?: string): Promise<void> {
    if (this.running) {
      throw new Error('A2A server already running');
    }

    const bindHost = host ?? this.resolveBindHost();

    this.server = http.createServer(this.handleRequest.bind(this));

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);

      this.server!.listen(port, bindHost, () => {
        this.running = true;
        const addr = this.server!.address() as AddressInfo;
        logger.log(`[A2A] Server listening on ${bindHost}:${addr.port}`);
        if (bindHost === ALL_INTERFACES_HOST) {
          logger.warn(
            '[A2A] Bound to all interfaces (A2A_BIND_ALL=true) — remote ' +
              'callers skip CORS; signature + authorization is the only gate.',
          );
        }
        resolve();
      });
    });
  }

  /**
   * Resolve the bind host: loopback unless A2A_BIND_ALL explicitly opts in.
   */
  private resolveBindHost(): string {
    return process.env.A2A_BIND_ALL === 'true' ? ALL_INTERFACES_HOST : LOOPBACK_HOST;
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
    // Read body with a hard size cap applied BEFORE JSON parse / auth so an
    // unauthenticated caller cannot exhaust memory.
    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err) {
      if ((err as Error).message === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      throw err;
    }

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

    // Verify signature + identity binding (X-Public-Key must derive to
    // task.senderPeerId and the signature must cover the payload hash).
    const valid = await this.authService.verify(task, senderPublicKey);
    if (!valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature or expired request' }));
      return;
    }

    // Authorize: signature proves WHO, this checks they are ALLOWED to run
    // this task type. Default-deny for unknown peers (FINDING 1).
    if (!this.authzService.isAuthorized(task.senderPeerId, task.type)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Peer not authorized for this task type' }));
      return;
    }

    // Route task
    const result = await this.taskRouter.route(task);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /**
   * Read the request body as a string, rejecting with PAYLOAD_TOO_LARGE once
   * the accumulated bytes exceed MAX_BODY_BYTES. Tracks raw byte length (not
   * string length) so multi-byte UTF-8 cannot smuggle past the cap.
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return; // already over cap — drain & discard
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          // Over the cap. Drop the buffered chunks and keep draining the
          // socket so the response (413) can still be written cleanly —
          // destroying the socket here would surface ECONNRESET to the
          // client before it reads our status.
          tooLarge = true;
          chunks.length = 0;
        } else {
          chunks.push(chunk);
        }
      });
      req.on('end', () => {
        if (tooLarge) {
          reject(new Error('PAYLOAD_TOO_LARGE'));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
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
