/**
 * F3-P2 — Synapseia serving client.
 *
 * Talks to the local inference runtime (llama.cpp server / vLLM) that
 * hosts the canonical Synapseia model. Operators launch the runtime
 * out-of-band; this class just speaks its HTTP API.
 *
 * Expects an OpenAI-compatible `/v1/chat/completions` endpoint at
 * `SYNAPSEIA_SERVING_URL` (default `http://127.0.0.1:8080`).
 *
 * The adapter + base weights are provisioned by `ActiveModelSubscriber`
 * before generation hits this client — so when we call, the URL is
 * expected to already be serving the current active version.
 */

import { Injectable } from '@nestjs/common';
import logger from '../../utils/logger';

export interface SynapseiaGenerateOptions {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface SynapseiaGenerateResult {
  content: string;
  modelVersion: string;
  latencyMs: number;
}

const DEFAULT_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 60_000;

@Injectable()
export class SynapseiaServingClient {
  /**
   * The serving URL + the Synapseia version currently loaded. Set by
   * `ActiveModelSubscriber` at boot and after every hot-reload.
   */
  private servingUrl: string;
  private activeVersion: string | null = null;

  constructor() {
    this.servingUrl = process.env.SYNAPSEIA_SERVING_URL ?? DEFAULT_URL;
  }

  setActiveVersion(version: string, url?: string): void {
    this.activeVersion = version;
    if (url) this.servingUrl = url;
    logger.info(
      `[SynapseiaServing] now serving ${version} at ${this.servingUrl}`,
    );
  }

  getActiveVersion(): string | null {
    return this.activeVersion;
  }

  /**
   * Returns `true` when the local runtime answers `GET /health` (or
   * `GET /v1/models`) within 2s. Used by the bidder to decide whether
   * to advertise a Synapseia bid this auction.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.servingUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(opts: SynapseiaGenerateOptions): Promise<SynapseiaGenerateResult> {
    if (!this.activeVersion) {
      throw new Error('Synapseia serving not initialized (no active version)');
    }
    const started = Date.now();
    const res = await fetch(`${this.servingUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.activeVersion,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 2048,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Synapseia serving HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new Error('Synapseia serving returned empty content');
    }
    return {
      content,
      modelVersion: this.activeVersion,
      latencyMs: Date.now() - started,
    };
  }
}
