/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ChatStreamHandler — registers an inbound libp2p protocol handler for
 * `/synapseia/chat/1.0.0`. When the coordinator opens a stream (after the
 * user paid), this reads the request frame, forwards to the node's
 * configured LLM (Ollama local OR cloud: MiniMax / Moonshot / Anthropic /
 * OpenAI-compat), and writes the OpenAI-shaped response back.
 *
 * Previously this hardcoded a fetch to Ollama at localhost:11434, which
 * ignored the node's LLM_PROVIDER=cloud config. On a tiny model like
 * qwen2.5:0.5b on CPU that took ~48s per query — right at the 60s coord
 * timeout. Routing through LlmProviderHelper picks up the same
 * (provider, providerId, apiKey, baseUrl) the training / research agent
 * already uses.
 */
import logger from '../../utils/logger';
import { P2PNode, CHAT_PROTOCOL } from '../p2p/p2p';
import { sendJsonOverStream, readJsonFromStream } from '../p2p/stream-codec';
import { LlmProviderHelper, type LLMModel, type LLMConfig } from '../llm/llm-provider';

interface ChatStreamRequest {
  sessionId: string;
  quoteId: string;
  messages: Array<{ role: string; content: string }>;
}

interface ChatStreamHandlerDeps {
  llmModel: LLMModel;
  llmConfig: LLMConfig;
}

export class ChatStreamHandler {
  private readonly llmProvider = new LlmProviderHelper();

  constructor(
    private readonly p2p: P2PNode,
    private readonly deps: ChatStreamHandlerDeps,
  ) {}

  async start(): Promise<void> {
    // libp2p v3 calls (stream, connection). Using `(ctx) => ctx.stream`
    // silently hands an undefined to readJsonFromStream and the peer
    // times out — do not change this signature without updating the
    // p2p.ts wrapper.
    await this.p2p.handleProtocol(CHAT_PROTOCOL, (stream, _connection) => {
      // Run without blocking the libp2p event loop.
      void this.onStream(stream);
    });
    const modelTag = this.deps.llmModel.provider === 'cloud'
      ? `${this.deps.llmModel.providerId}/${this.deps.llmModel.modelId}`
      : this.deps.llmModel.modelId;
    logger.log(`[ChatStreamHandler] listening on ${CHAT_PROTOCOL} (llm=${modelTag})`);
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
          ` (${req.messages.length} messages) — generating via ${this.deps.llmModel.provider}`,
      );

      const t0 = Date.now();
      const response = await this.generateAnswer(req.messages);
      logger.log(`[ChatStreamHandler] ✓ LLM responded in ${Date.now() - t0}ms — writing response`);
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
    }
  }

  /**
   * Flatten chat messages into a single prompt that preserves role context
   * (the LlmProviderHelper.generateLLM API is prompt-based, not
   * messages-based). This keeps the implementation simple — a future
   * iteration can add a chat-native path through the cloud providers'
   * `/chat/completions` endpoints to preserve tool-use / fine control.
   */
  private async generateAnswer(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ choices: Array<{ message: { role: string; content: string } }> }> {
    const prompt = this.flattenMessagesToPrompt(messages);
    const content = await this.llmProvider.generateLLM(
      this.deps.llmModel,
      prompt,
      this.deps.llmConfig,
      { temperature: 0.7, maxTokens: 2048 },
    );
    return { choices: [{ message: { role: 'assistant', content } }] };
  }

  private flattenMessagesToPrompt(messages: Array<{ role: string; content: string }>): string {
    const parts: string[] = [
      'You are Synapseia-Agent, a biomedical research assistant. Answer the user concisely and truthfully. If you do not know, say so.',
    ];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      parts.push(`${role}: ${m.content}`);
    }
    parts.push('Assistant:');
    return parts.join('\n\n');
  }
}
