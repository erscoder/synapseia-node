import { OpenAICompatAdapter } from './openai-compat.adapter';
import { CLOUD_PROVIDERS_BY_ID } from '../providers';
import { readNumber, readString } from './llm-response-adapter';

/**
 * MiniMax application-level error codes that should be retried as
 * transient. 1002/1004 = QPS rate limit; 1027 = sensitive-content
 * temporary block; 2013 = internal request timeout; 2064 = "server
 * cluster under high load" (the famous one we already retry by string
 * match).
 */
const MINIMAX_TRANSIENT_CODES = new Set<number>([1002, 1004, 1027, 2013, 2064]);

/**
 * Adapter for MiniMax.
 *
 * Endpoint: https://api.minimax.io/v1/chat/completions  (OpenAI-shaped)
 *
 * MiniMax's quirk: HTTP 200 doesn't mean the request succeeded. Every
 * response carries a `base_resp` envelope:
 *   {
 *     "id": "...",
 *     "choices": [...],
 *     "usage": {...},
 *     "base_resp": { "status_code": 0, "status_msg": "" }
 *   }
 * `status_code !== 0` signals an application-level failure even when
 * the HTTP layer reported OK. We classify a known set of codes as
 * transient (retry) and let the rest bubble up as fatal.
 */
export class MinimaxAdapter extends OpenAICompatAdapter {
  readonly providerId = 'minimax';
  protected readonly endpoint = (() => {
    const e = CLOUD_PROVIDERS_BY_ID.get('minimax')?.endpoint;
    if (!e) throw new Error('minimax provider missing from CLOUD_PROVIDERS table');
    return e;
  })();

  protected validateResponseBody(body: unknown): void {
    const code = readNumber(body, 'base_resp', 'status_code');
    if (code !== undefined && code !== 0) {
      const msg = readString(body, 'base_resp', 'status_msg') ?? 'unknown';
      // Tag transient errors with a recognisable substring so the
      // top-level retry loop in llm-provider.ts catches them via
      // isTransientLlmError(). The retry loop already string-matches
      // on '2064' / 'high load' / 'rate limit'.
      const transient = MINIMAX_TRANSIENT_CODES.has(code);
      throw new Error(
        `MiniMax base_resp ${code}: ${msg}` +
          (transient ? ' (transient)' : ''),
      );
    }
  }

  isTransientError(err: unknown): boolean {
    const msg = String((err as { message?: unknown })?.message ?? err ?? '');
    if (msg.includes('(transient)')) return true;
    for (const code of MINIMAX_TRANSIENT_CODES) {
      if (msg.includes(`base_resp ${code}`)) return true;
    }
    return false;
  }
}
