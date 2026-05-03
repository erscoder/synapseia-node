import { OpenAICompatAdapter } from './openai-compat.adapter';
import { CLOUD_PROVIDERS_BY_ID } from '../providers';

/**
 * Adapter for Moonshot AI (Kimi brand).
 *
 * Endpoint: https://api.moonshot.ai/v1/chat/completions  (OpenAI-compatible)
 *
 * Kimi K2 / K2.6 split chain-of-thought into a separate
 * `choices[0].message.reasoning_content` field while keeping the final
 * answer in `choices[0].message.content`. Reading only `content` (the
 * default in OpenAICompatAdapter) is therefore correct — we just need to
 * avoid concatenating `reasoning_content` by accident, which the base
 * class already does.
 *
 * Endpoint hostname is `api.moonshot.ai` (international tenant). The
 * `.cn` host requires an ICP-registered key and will refuse foreign
 * traffic, so we never default to it; operators can override via env if
 * they need to.
 */
export class MoonshotAdapter extends OpenAICompatAdapter {
  readonly providerId = 'moonshot';
  protected readonly endpoint = (() => {
    const e = CLOUD_PROVIDERS_BY_ID.get('moonshot')?.endpoint;
    if (!e) throw new Error('moonshot provider missing from CLOUD_PROVIDERS table');
    return e;
  })();
}
