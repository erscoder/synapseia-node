import { OpenAICompatAdapter } from './openai-compat.adapter';
import { CLOUD_PROVIDERS_BY_ID } from '../providers';

/**
 * Adapter for NVIDIA NIM (build.nvidia.com hosted inference).
 *
 * Endpoint: https://integrate.api.nvidia.com/v1/chat/completions
 * (OpenAI-compatible).
 *
 * Free tier: ~5,000 credits/month for verified NGC developers. Synapseia
 * operators get a personal `nvapi-...` key at build.nvidia.com and run
 * the node without paying a vendor or owning a local GPU.
 *
 * Models served (see CLOUD_PROVIDERS) are Meta Llama variants and NVIDIA
 * Nemotron-3 series. Default `top` is `nvidia/nemotron-3-super-120b-a12b`:
 * a 120B MoE post-trained by NVIDIA for instruction-following + scientific
 * reasoning, which aligns with Synapseia's biomedical KG / peer-review work.
 *
 * The OpenAI-compat path covers the wire format end-to-end; no NIM-specific
 * quirks need shimming today (reasoning_format defaults to `parsed` for
 * GPT-OSS-style models, which keeps `choices[0].message.content` clean of
 * `<think>` wrappers).
 */
export class NvidiaAdapter extends OpenAICompatAdapter {
  readonly providerId = 'nvidia';
  protected readonly endpoint = (() => {
    const e = CLOUD_PROVIDERS_BY_ID.get('nvidia')?.endpoint;
    if (!e) throw new Error('nvidia provider missing from CLOUD_PROVIDERS table');
    return e;
  })();
}
