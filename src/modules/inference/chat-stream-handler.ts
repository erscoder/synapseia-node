/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ChatStreamHandler — registers an inbound libp2p protocol handler for
 * `/synapseia/chat/1.0.0`. When the coordinator opens a stream (after the
 * user paid), this reads the request frame, forwards the messages to local
 * Ollama, and writes the OpenAI-shaped response back.
 *
 * Replaces the HTTP POST /v1/chat/completions forward path. Runs over an
 * already-established libp2p connection — no TCP/TLS handshake per query.
 * The HTTP handler in inference-server.ts stays alive for rolling upgrades.
 */
import logger from '../../utils/logger';
import { P2PNode, CHAT_PROTOCOL } from '../p2p/p2p';
import { sendJsonOverStream, readJsonFromStream } from '../p2p/stream-codec';

interface ChatStreamRequest {
  sessionId: string;
  quoteId: string;
  messages: Array<{ role: string; content: string }>;
}

const OLLAMA_DEFAULT = 'http://localhost:11434';

export class ChatStreamHandler {
  constructor(private readonly p2p: P2PNode) {}

  async start(): Promise<void> {
    // libp2p v3 calls (stream, connection). Using `(ctx) => ctx.stream`
    // silently hands an undefined to readJsonFromStream and the peer
    // times out — do not change this signature without updating the
    // p2p.ts wrapper.
    await this.p2p.handleProtocol(CHAT_PROTOCOL, (stream, _connection) => {
      // Run without blocking the libp2p event loop.
      void this.onStream(stream);
    });
    logger.log(`[ChatStreamHandler] listening on ${CHAT_PROTOCOL}`);
  }

  private async onStream(stream: any): Promise<void> {
    logger.log(`[ChatStreamHandler] ⚡ inbound stream opened — reading request…`);
    try {
      const req = await readJsonFromStream<ChatStreamRequest>(stream);
      if (!req?.messages || !Array.isArray(req.messages)) {
        await sendJsonOverStream(stream, {
          choices: [{ message: { role: 'assistant', content: 'invalid request' } }],
        });
        return;
      }

      logger.log(
        `[ChatStreamHandler] ▶ quote ${req.quoteId?.slice(0, 8)}… session ${req.sessionId?.slice(0, 8)}…` +
          ` (${req.messages.length} messages) — forwarding to Ollama`,
      );

      const t0 = Date.now();
      const response = await this.forwardToOllama(req.messages);
      logger.log(`[ChatStreamHandler] ✓ Ollama responded in ${Date.now() - t0}ms — writing response`);
      await sendJsonOverStream(stream, response);
      logger.log(`[ChatStreamHandler] ✓ response sent for quote ${req.quoteId?.slice(0, 8)}…`);
    } catch (err) {
      logger.warn(`[ChatStreamHandler] stream error: ${(err as Error).message}`);
      try {
        await sendJsonOverStream(stream, {
          choices: [{ message: { role: 'assistant', content: `error: ${(err as Error).message}` } }],
        });
      } catch {
        // swallow — peer likely gone
      }
    } finally {
      try { await stream.close?.(); } catch { /* ignore */ }
    }
  }

  private async forwardToOllama(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ choices: Array<{ message: { role: string; content: string } }> }> {
    const url = (process.env.OLLAMA_URL ?? OLLAMA_DEFAULT).replace(/\/+$/, '');
    const model = process.env.LLM_MODEL ?? 'qwen2.5:0.5b';
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { role?: string; content?: string } };
    const content = body.message?.content ?? '';
    return {
      choices: [
        { message: { role: body.message?.role ?? 'assistant', content } },
      ],
    };
  }
}
