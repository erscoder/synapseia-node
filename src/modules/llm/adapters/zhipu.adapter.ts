import { OpenAICompatAdapter } from './openai-compat.adapter';
import { CLOUD_PROVIDERS_BY_ID } from '../providers';

/**
 * Adapter for Zhipu AI (GLM family — glm-4.6, glm-4-plus, glm-4-flash).
 *
 * Endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions
 *
 * Strict OpenAI-compatible: `choices[0].message.content` carries the
 * answer, `usage.{prompt,completion,total}_tokens` carry telemetry,
 * `error.message` carries error text. No app-level envelope tricks.
 *
 * The only meaningful difference from the OpenAI base is the endpoint
 * host, which is why this class has no overrides beyond identification.
 */
export class ZhipuAdapter extends OpenAICompatAdapter {
  readonly providerId = 'zhipu';
  protected readonly endpoint = (() => {
    const e = CLOUD_PROVIDERS_BY_ID.get('zhipu')?.endpoint;
    if (!e) throw new Error('zhipu provider missing from CLOUD_PROVIDERS table');
    return e;
  })();
}
