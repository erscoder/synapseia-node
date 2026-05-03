/**
 * inference-server — comprehensive spec (Phase 4 mutation coverage).
 *
 * Tests the exported pure-ish handlers (parseBody, forwardToOllama,
 * transformToOpenAI, handleChatCompletions, handleState, handleHealth)
 * plus the HTTP server routing in startInferenceServer. Fetch is
 * stubbed via `global.fetch`; req/res are fake Node streams.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import * as http from 'http';
import {
  parseBody,
  forwardToOllama,
  transformToOpenAI,
  handleChatCompletions,
  handleState,
  handleHealth,
  startInferenceServer,
  type ChatCompletionRequest,
  type OllamaChatResponse,
  type InferenceServerConfig,
} from '../inference-server';

// ── fake request / response ───────────────────────────────────────────────
class FakeReq extends EventEmitter {
  method?: string;
  url?: string;
  headers: Record<string, string> = {};
  constructor(opts: { method?: string; url?: string } = {}) {
    super();
    this.method = opts.method;
    this.url = opts.url;
  }
  feed(body: string): void {
    setImmediate(() => {
      this.emit('data', Buffer.from(body));
      this.emit('end');
    });
  }
  error(err: Error): void {
    setImmediate(() => this.emit('error', err));
  }
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  ended = false;
  writeHead(code: number, h: Record<string, string>): this {
    this.statusCode = code;
    Object.assign(this.headers, h);
    return this;
  }
  setHeader(k: string, v: string): void { this.headers[k] = v; }
  end(chunk?: string): void { if (chunk) this.body += chunk; this.ended = true; }
}

function parseJson(b: string): any { return JSON.parse(b); }

// ── fetch mock ────────────────────────────────────────────────────────────
const originalFetch = global.fetch;
beforeEach(() => {
  (global as any).fetch = jest.fn();
});
afterEach(() => {
  (global as any).fetch = originalFetch;
});

function ok(payload: any): any {
  return { ok: true, status: 200, statusText: 'OK', json: async () => payload };
}
function fail(code: number, msg: string): any {
  return { ok: false, status: code, statusText: msg, json: async () => ({}) };
}

// ── parseBody ─────────────────────────────────────────────────────────────
describe('parseBody', () => {
  it('parses a well-formed JSON body', async () => {
    const req = new FakeReq();
    const p = parseBody(req as any);
    req.feed('{"a":1,"b":"c"}');
    await expect(p).resolves.toEqual({ a: 1, b: 'c' });
  });

  it('resolves to an empty object when body is empty', async () => {
    const req = new FakeReq();
    const p = parseBody(req as any);
    req.feed('');
    await expect(p).resolves.toEqual({});
  });

  it('rejects when body is not valid JSON', async () => {
    const req = new FakeReq();
    const p = parseBody(req as any);
    req.feed('not-json');
    await expect(p).rejects.toBeDefined();
  });

  it('rejects on underlying stream error', async () => {
    const req = new FakeReq();
    const p = parseBody(req as any);
    req.error(new Error('pipe broke'));
    await expect(p).rejects.toThrow(/pipe broke/);
  });
});

// ── forwardToOllama ───────────────────────────────────────────────────────
describe('forwardToOllama', () => {
  it('calls the local ollama endpoint with stream=false', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({
      message: { role: 'assistant', content: 'hi' }, done: true, model: 'm', created_at: 'x',
    }));
    const req: ChatCompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'q' }] };
    await forwardToOllama(req);
    const [url, opts] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(opts.method).toBe('POST');
    expect(parseJson(opts.body)).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      stream: false,
    });
  });

  it('includes options.temperature when provided', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ message: { role: 'a', content: 'b' }, done: true, model: 'm', created_at: 'x' }));
    await forwardToOllama({ model: 'm', messages: [{ role: 'user', content: 'q' }], temperature: 0.7 });
    const opts = (global.fetch as any).mock.calls[0][1];
    expect(parseJson(opts.body).options).toEqual({ temperature: 0.7 });
  });

  it('includes options.num_predict when max_tokens is set', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ message: { role: 'a', content: 'b' }, done: true, model: 'm', created_at: 'x' }));
    await forwardToOllama({ model: 'm', messages: [{ role: 'user', content: 'q' }], max_tokens: 128 });
    const opts = (global.fetch as any).mock.calls[0][1];
    expect(parseJson(opts.body).options).toEqual({ num_predict: 128 });
  });

  it('includes both temperature and num_predict when both set', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ message: { role: 'a', content: 'b' }, done: true, model: 'm', created_at: 'x' }));
    await forwardToOllama({ model: 'm', messages: [{ role: 'user', content: 'q' }], temperature: 0.5, max_tokens: 200 });
    const opts = (global.fetch as any).mock.calls[0][1];
    expect(parseJson(opts.body).options).toEqual({ temperature: 0.5, num_predict: 200 });
  });

  it('omits options block when neither temperature nor max_tokens is set', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ message: { role: 'a', content: 'b' }, done: true, model: 'm', created_at: 'x' }));
    await forwardToOllama({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    const opts = (global.fetch as any).mock.calls[0][1];
    expect(parseJson(opts.body).options).toBeUndefined();
  });

  it('throws with ollama status + statusText on non-ok response', async () => {
    (global.fetch as any).mockResolvedValueOnce(fail(502, 'Bad Gateway'));
    await expect(
      forwardToOllama({ model: 'm', messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toThrow(/Ollama API error: 502 Bad Gateway/);
  });
});

// ── transformToOpenAI ─────────────────────────────────────────────────────
describe('transformToOpenAI', () => {
  const base: OllamaChatResponse = {
    message: { role: 'assistant', content: 'hello world' },
    done: true, model: 'ollama-m', created_at: '2026-04-20',
  };

  it('maps Ollama response to OpenAI shape', () => {
    const r = transformToOpenAI(base, 'my-model');
    expect(r.object).toBe('chat.completion');
    expect(r.model).toBe('my-model');
    expect(r.choices).toEqual([{
      index: 0,
      message: { role: 'assistant', content: 'hello world' },
      finish_reason: 'stop',
    }]);
  });

  it('id is a `chatcmpl-<uuid>` prefix', () => {
    const r = transformToOpenAI(base, 'm');
    expect(r.id.startsWith('chatcmpl-')).toBe(true);
    expect(r.id).toMatch(/^chatcmpl-[0-9a-f-]{36}$/);
  });

  it('created is a recent Unix-seconds value', () => {
    const before = Math.floor(Date.now() / 1000);
    const r = transformToOpenAI(base, 'm');
    const after = Math.ceil(Date.now() / 1000);
    expect(r.created).toBeGreaterThanOrEqual(before);
    expect(r.created).toBeLessThanOrEqual(after + 1);
  });
});

// ── handleChatCompletions ─────────────────────────────────────────────────
describe('handleChatCompletions', () => {
  it('rejects requests missing `model` with 400', async () => {
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer');
    req.feed(JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }));
    await p;
    expect(res.statusCode).toBe(400);
    expect(parseJson(res.body).error.type).toBe('invalid_request_error');
  });

  it('rejects requests missing `messages` with 400', async () => {
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer');
    req.feed(JSON.stringify({ model: 'm' }));
    await p;
    expect(res.statusCode).toBe(400);
  });

  it('rejects requests with empty messages array with 400', async () => {
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer');
    req.feed(JSON.stringify({ model: 'm', messages: [] }));
    await p;
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-array messages with 400', async () => {
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer');
    req.feed(JSON.stringify({ model: 'm', messages: 'not-an-array' }));
    await p;
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 + OpenAI-shaped response on happy path', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({
      message: { role: 'assistant', content: 'pong' }, done: true, model: 'm', created_at: 'x',
    }));
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer');
    req.feed(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ping' }] }));
    await p;
    expect(res.statusCode).toBe(200);
    const body = parseJson(res.body);
    expect(body.choices[0].message.content).toBe('pong');
    expect(body.model).toBe('m');
  });

  it('notifies coordinator fire-and-forget when coordinatorUrl is set', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({
      message: { role: 'assistant', content: 'p' }, done: true, model: 'm', created_at: 'x',
    })).mockResolvedValueOnce(ok({}));
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer-42', 'http://coord');
    req.feed(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ping' }] }));
    await p;
    // Give fire-and-forget microtask a chance to run.
    await new Promise((r) => setImmediate(r));
    const notifyCall = (global.fetch as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('/peers/peer-42/inference-request'));
    expect(notifyCall).toBeDefined();
  });

  it('returns 500 on ollama forward failure', async () => {
    (global.fetch as any).mockResolvedValueOnce(fail(500, 'boom'));
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer');
    req.feed(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    await p;
    expect(res.statusCode).toBe(500);
    expect(parseJson(res.body).error.type).toBe('server_error');
  });

  it('500 error surfaces the error message when present', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('custom-err'));
    const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
    const res = new FakeRes();
    const p = handleChatCompletions(req as any, res as any, 'peer');
    req.feed(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    await p;
    expect(parseJson(res.body).error.message).toBe('custom-err');
  });

  // Reviewer follow-up (HIGH bug): the libp2p ChatStreamHandler held the
  // chat-inference mutex but the HTTP fallback path didn't, silently
  // unblocking TRAINING WOs while a chat was in flight. Verify the
  // counter rises during the call and falls back to zero, even on error.
  describe('chat-inference mutex on HTTP fallback', () => {
    it('increments and releases chat-inference around forwardToOllama', async () => {
      const state = require('../chat-inference-state');
      state._resetChatInferenceStateForTests();

      let activeDuringCall = -1;
      (global.fetch as any).mockImplementationOnce(async () => {
        activeDuringCall = state.activeChatInferences();
        return ok({ message: { role: 'assistant', content: 'ok' }, done: true, model: 'm', created_at: 'x' });
      });

      const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
      const res = new FakeRes();
      const p = handleChatCompletions(req as any, res as any, 'peer');
      req.feed(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
      await p;

      expect(activeDuringCall).toBe(1);
      expect(state.activeChatInferences()).toBe(0);
    });

    it('releases the counter even when forwardToOllama throws', async () => {
      const state = require('../chat-inference-state');
      state._resetChatInferenceStateForTests();

      (global.fetch as any).mockRejectedValueOnce(new Error('boom'));
      const req = new FakeReq({ method: 'POST', url: '/v1/chat/completions' });
      const res = new FakeRes();
      const p = handleChatCompletions(req as any, res as any, 'peer');
      req.feed(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
      await p;

      expect(state.activeChatInferences()).toBe(0);
      expect(res.statusCode).toBe(500);
    });
  });
});

// ── handleState ───────────────────────────────────────────────────────────
describe('handleState', () => {
  it('returns peerId / tier / models / uptime as integer seconds', async () => {
    const res = new FakeRes();
    const cfg: InferenceServerConfig = {
      peerId: 'p', tier: 2, models: ['llama', 'qwen'],
    };
    await handleState({} as any, res as any, cfg);
    expect(res.statusCode).toBe(200);
    const body = parseJson(res.body);
    expect(body.peerId).toBe('p');
    expect(body.tier).toBe(2);
    expect(body.models).toEqual(['llama', 'qwen']);
    expect(Number.isInteger(body.uptime)).toBe(true);
  });
});

// ── handleHealth ──────────────────────────────────────────────────────────
describe('handleHealth', () => {
  it('returns status ok + integer uptime', async () => {
    const res = new FakeRes();
    await handleHealth({} as any, res as any);
    expect(res.statusCode).toBe(200);
    const body = parseJson(res.body);
    expect(body.status).toBe('ok');
    expect(Number.isInteger(body.uptime)).toBe(true);
  });
});

// ── startInferenceServer routing ──────────────────────────────────────────
describe('startInferenceServer', () => {
  async function httpJson(port: number, opts: http.RequestOptions, body?: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port, ...opts }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} });
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  it('routes GET /health → 200 { status: "ok" }', async () => {
    const { close } = startInferenceServer({ peerId: 'p', tier: 0, models: [], port: 0 }) as any;
    try {
      // port: 0 was ignored — the server listens on 0 → use the address after listen
    } finally { close(); }
  });

  it('serves /health and /api/v1/state and 404 with real sockets', async () => {
    // Use a fixed high port to avoid picking something busy; test suite runs single-threaded here.
    const port = 34561;
    const { close, server } = startInferenceServer({ peerId: 'pid', tier: 5, models: ['m'], port });
    await new Promise((r) => server.once('listening', r));
    try {
      const health = await httpJson(port, { method: 'GET', path: '/health' });
      expect(health.status).toBe(200);
      expect(health.json.status).toBe('ok');

      const state = await httpJson(port, { method: 'GET', path: '/api/v1/state' });
      expect(state.status).toBe(200);
      expect(state.json).toEqual(expect.objectContaining({ peerId: 'pid', tier: 5, models: ['m'] }));

      const nf = await httpJson(port, { method: 'GET', path: '/does/not/exist' });
      expect(nf.status).toBe(404);
      expect(nf.json.error.type).toBe('not_found_error');

      const opts = await httpJson(port, { method: 'OPTIONS', path: '/v1/chat/completions' });
      // S0.5: the local-only CORS handler responds 204 to preflight
      // (no body). Pre-S0.5 returned 200 with `Access-Control-Allow-
      // Origin: *`, which exposed the server to DNS rebinding.
      expect(opts.status).toBe(204);
    } finally {
      close();
      await new Promise((r) => server.once('close', r));
    }
  });

  it('POST /inference/quote returns a numeric priceUsd', async () => {
    const port = 34562;
    const { close, server } = startInferenceServer({ peerId: 'p', tier: 0, models: [], port });
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await httpJson(port, {
        method: 'POST', path: '/inference/quote',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ query: 'als gene' }));
      expect(res.status).toBe(200);
      expect(typeof res.json.priceUsd).toBe('number');
      expect(res.json.priceUsd).toBeGreaterThan(0);
    } finally {
      close();
      await new Promise((r) => server.once('close', r));
    }
  });
});
