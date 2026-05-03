import { type CloudProviderId } from '../providers';
import { type LLMResponseAdapter } from './llm-response-adapter';
import { OpenAIAdapter } from './openai.adapter';
import { AnthropicAdapter } from './anthropic.adapter';
import { GoogleAdapter } from './google.adapter';
import { MoonshotAdapter } from './moonshot.adapter';
import { MinimaxAdapter } from './minimax.adapter';
import { ZhipuAdapter } from './zhipu.adapter';

/**
 * Adapter registry keyed by provider id. The map is built at module
 * load and kept immutable; tests can substitute entries via the
 * exported map by spreading into a new instance, but production code
 * just calls `getAdapter()`.
 */
const ADAPTERS: ReadonlyMap<CloudProviderId, LLMResponseAdapter> = new Map<CloudProviderId, LLMResponseAdapter>([
  ['openai', new OpenAIAdapter()],
  ['anthropic', new AnthropicAdapter()],
  ['google', new GoogleAdapter()],
  ['moonshot', new MoonshotAdapter()],
  ['minimax', new MinimaxAdapter()],
  ['zhipu', new ZhipuAdapter()],
]);

export function getAdapter(providerId: CloudProviderId): LLMResponseAdapter {
  const adapter = ADAPTERS.get(providerId);
  if (!adapter) {
    throw new Error(`No LLM response adapter registered for provider '${providerId}'`);
  }
  return adapter;
}

export { ADAPTERS as CLOUD_ADAPTERS };

export {
  type ChatRequest,
  type ChatHyperparams,
  type LLMResponseAdapter,
  type NormalizedResponse,
  type FinishReason,
} from './llm-response-adapter';
