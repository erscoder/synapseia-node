/**
 * OpenAI-compatible inference server
 * Routes:
 * - POST /v1/chat/completions → proxy to Ollama at localhost:11434/api/chat
 * - GET /api/v1/state → { peerId, tier, models: string[], uptime: number }
 * - GET /health → { status: 'ok', uptime: number }
 */

import { Injectable } from '@nestjs/common';
import * as http from 'http';
import * as crypto from 'crypto';
import logger from '../../utils/logger';
import { priceUsdFromEnv } from './QueryCostCalculator';
import { beginChatInference, endChatInference } from './chat-inference-state';

export interface InferenceServerConfig {
  port?: number;
  peerId: string;
  tier: number;
  models: string[];
  coordinatorUrl?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

export interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
  model: string;
  created_at: string;
}

let serverStartTime: number;

/**
 * Parse JSON body from incoming request
 * Exported for testing
 */
// Standalone handlers exported for backward compatibility
export function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Forward request to Ollama API
 * Exported for testing
 */
export async function forwardToOllama(request: ChatCompletionRequest): Promise<OllamaChatResponse> {
  const ollamaRequest: OllamaChatRequest = {
    model: request.model,
    messages: request.messages,
    stream: false,
  };

  if (request.temperature !== undefined || request.max_tokens !== undefined) {
    ollamaRequest.options = {};
    if (request.temperature !== undefined) {
      ollamaRequest.options.temperature = request.temperature;
    }
    if (request.max_tokens !== undefined) {
      ollamaRequest.options.num_predict = request.max_tokens;
    }
  }

  const ollamaResponse = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(ollamaRequest),
  });

  if (!ollamaResponse.ok) {
    throw new Error(`Ollama API error: ${ollamaResponse.status} ${ollamaResponse.statusText}`);
  }

  return ollamaResponse.json() as Promise<OllamaChatResponse>;
}

/**
 * Transform Ollama response to OpenAI format
 * Exported for testing
 */
export function transformToOpenAI(ollamaResponse: OllamaChatResponse, model: string): ChatCompletionResponse {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: ollamaResponse.message.role,
          content: ollamaResponse.message.content,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

/**
 * Notify coordinator of a successful inference request (fire-and-forget)
 */
async function notifyCoordinatorInferenceRequest(coordinatorUrl: string, peerId: string): Promise<void> {
  try {
    await fetch(`${coordinatorUrl}/peers/${encodeURIComponent(peerId)}/inference-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Fire-and-forget: do not fail inference if coordinator is unreachable
  }
}

/**
 * Handle POST /v1/chat/completions
 * Exported for testing
 */
export async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  peerId: string,
  coordinatorUrl?: string,
): Promise<void> {
  try {
    const body = await parseBody(req) as ChatCompletionRequest;

    if (!body.model || !body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Invalid request: model and messages are required',
          type: 'invalid_request_error',
        },
      }));
      return;
    }

    // HTTP fallback path matters when libp2p is degraded — coordinator's
    // ChatStreamClient drops to /v1/chat/completions. Without this hook the
    // TRAINING mutex (audit 2026-04-24, A1) silently fails open and the
    // coordinator times out again.
    beginChatInference();
    let ollamaResponse;
    try {
      ollamaResponse = await forwardToOllama(body);
    } finally {
      endChatInference();
    }
    const openaiResponse = transformToOpenAI(ollamaResponse, body.model);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openaiResponse));

    // Notify coordinator (fire-and-forget) after successful inference
    if (coordinatorUrl) {
      void notifyCoordinatorInferenceRequest(coordinatorUrl, peerId);
    }
  } catch (error: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
      },
    }));
  }
}

/**
 * Handle GET /api/v1/state
 * Exported for testing
 */
export async function handleState(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: InferenceServerConfig,
): Promise<void> {
  const uptime = process.uptime();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    peerId: config.peerId,
    tier: config.tier,
    models: config.models,
    uptime: Math.floor(uptime),
  }));
}

/**
 * Handle GET /health
 * Exported for testing
 */
export async function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const uptime = process.uptime();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    uptime: Math.floor(uptime),
  }));
}

/**
 * Handle 404
 */
/**
 * Vickrey auction bid endpoint. Coordinator fan-outs `POST /inference/quote`
 * to every alive node; each returns its price for the given query. Uses the
 * shared deterministic QueryCostCalculator so the coordinator can sanity-check
 * quotes for drift. Returns min price (0.1 USD) on any parsing error — never
 * rejects the bid, but always returns something the auction can rank.
 */
async function handleQuote(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseBody(req);
    const query = typeof body?.query === 'string' ? body.query : '';
    const priceUsd = priceUsdFromEnv(query);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ priceUsd }));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ priceUsd: priceUsdFromEnv('') }));
  }
}

function handleNotFound(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: 'Not found',
      type: 'not_found_error',
    },
  }));
}

/**
 * Start inference server
 */
export function startInferenceServer(config: InferenceServerConfig): { close: () => void; server: http.Server } {
  serverStartTime = Date.now();
  const port = config.port !== undefined && config.port !== null ? config.port : 8080;

  const server = http.createServer(async (req, res) => {
    // S0.5: strict local-only CORS. Pre-S0.5 this server returned
    // `Allow-Origin: *`, exposing it to any open browser tab via DNS
    // rebinding (audit P0 #5). The shared helper echoes the request
    // origin only when it matches localhost / 127.0.0.1 / tauri://,
    // and short-circuits OPTIONS preflights.
    const { applyLocalCors } = await import('../../shared/local-cors');
    if (applyLocalCors(req, res)) return;

    const url = req.url || '';

    try {
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        await handleChatCompletions(req, res, config.peerId, config.coordinatorUrl);
      } else if (req.method === 'POST' && url === '/inference/quote') {
        await handleQuote(req, res);
      } else if (req.method === 'GET' && url === '/api/v1/state') {
        await handleState(req, res, config);
      } else if (req.method === 'GET' && url === '/health') {
        await handleHealth(req, res);
      } else {
        handleNotFound(req, res);
      }
    } catch (error) {
      logger.error(`[InferenceServer] request error: ${(error as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Internal server error',
          type: 'server_error',
        },
      }));
    }
  });

  server.listen(port, () => {
    // Single structured line — the rest (routes) is documented in the
    // bootstrap banner elsewhere. Keeping the log terse makes it line up
    // with the other `[...]` tagged lines from the logger utility.
    logger.log(`[InferenceServer] listening on port ${port} (POST /v1/chat/completions, POST /inference/quote, GET /api/v1/state, GET /health)`);
  });

  return {
    server,
    close: () => {
      server.close();
      logger.log('[InferenceServer] closed');
    },
  };
}

@Injectable()
export class InferenceServerHelper {
  parseBody(req: http.IncomingMessage): Promise<any> {
    return parseBody(req);
  }

  forwardToOllama(request: ChatCompletionRequest): Promise<OllamaChatResponse> {
    return forwardToOllama(request);
  }

  transformToOpenAI(ollamaResponse: OllamaChatResponse, model: string): ChatCompletionResponse {
    return transformToOpenAI(ollamaResponse, model);
  }

  handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    peerId: string,
    coordinatorUrl?: string,
  ): Promise<void> {
    return handleChatCompletions(req, res, peerId, coordinatorUrl);
  }

  handleState(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: InferenceServerConfig,
  ): Promise<void> {
    return handleState(req, res, config);
  }

  handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleHealth(req, res);
  }

  startInferenceServer(config: InferenceServerConfig): { close: () => void; server: http.Server } {
    return startInferenceServer(config);
  }
}
